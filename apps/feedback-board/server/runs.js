import fs from "node:fs";
import path from "node:path";
import { appRoot, loadConfig } from "./config.js";
import { runProcess } from "./exec.js";
import {
  boardGitEnv,
  commitArgs,
  killProcessGroup,
  pullRequestText,
  pushArgs,
  scrubAgentEnv,
  spawnGrok,
} from "./agent-launch.js";
import {
  assertHeadOnBranch,
  assessLocalConfig,
  evaluateRemoteGuard,
  evaluateStartGuards,
  findOutOfScopePaths,
  gateDiffArgs,
  gateRawArgs,
  listChangedPaths,
  LOCAL_CONFIG_PATTERN,
  pathContainsLumen,
  symlinkPathsFromRaw,
  symlinkPathsOnDisk,
} from "./guard.js";
import { buildAgentPrompt } from "./prompt.js";
import { mutateState, readState } from "./store.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA = /^[0-9a-f]{40}$/i;
const PR_URL = /^https:\/\/github\.com\/ixefKos\/Grok\/pull\/\d+$/;

const processes = new Map();
let runningCardId = null;

export function getRunningCardId() {
  return runningCardId;
}

export function localDay(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function runsOnDay(state, today = localDay()) {
  if (!state.usage || state.usage.date !== today) return 0;
  return Number.isInteger(state.usage.count) ? state.usage.count : 0;
}

function logFile(cardId, root = appRoot()) {
  return path.join(root, "data", "runs", `${cardId}.log`);
}

function appendLog(cardId, text) {
  const file = logFile(cardId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, text);
}

function clip(text) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  if (!clean) return "The run failed.";
  return clean.length > 400 ? `${clean.slice(0, 400)}…` : clean;
}

async function logged(cardId, command, args, options = {}) {
  appendLog(cardId, `\n$ ${command} ${args.join(" ")}\n`);
  return runProcess(command, args, {
    ...options,
    onData: options.redactOutput ? () => {} : (chunk) => appendLog(cardId, chunk),
  });
}

async function markCard(cardId, fields) {
  await mutateState((state) => {
    const card = state.cards.find((item) => item.id === cardId);
    if (!card) return { ok: false, error: "Card not found." };
    Object.assign(card, fields, { updatedAt: new Date().toISOString() });
  });
}

function branchFor(cardId) {
  return `feedback/card-${cardId}`;
}

export async function reconcileInterruptedRuns() {
  await mutateState((state) => {
    for (const card of state.cards) {
      if (card.runStatus !== "running") continue;
      card.runStatus = "error";
      card.message = "Run interrupted because the board restarted.";
      card.updatedAt = new Date().toISOString();
    }
  });
  runningCardId = null;
  processes.clear();
}

export async function startCardRun(cardId) {
  if (!UUID.test(cardId)) return { ok: false, status: 400, error: "Card id is not valid." };
  if (runningCardId) {
    return { ok: false, status: 409, error: "Another run is already in progress." };
  }
  runningCardId = cardId;
  try {
    const outcome = await prepareAndSpawn(cardId);
    if (!outcome.spawned) runningCardId = null;
    return outcome;
  } catch (error) {
    if (runningCardId === cardId) runningCardId = null;
    return { ok: false, status: 500, error: clip(error.message) };
  }
}

async function readConfigScope(cardId, cwd, scope) {
  return logged(cardId, "git", ["config", scope, "--get-regexp", LOCAL_CONFIG_PATTERN], {
    cwd,
    timeoutMs: 15000,
    redactOutput: true,
  });
}

async function readOriginGuard(cardId, cwd) {
  const fetch = await logged(cardId, "git", ["remote", "get-url", "--all", "origin"], {
    cwd,
    timeoutMs: 15000,
    redactOutput: true,
  });
  const push = await logged(cardId, "git", ["remote", "get-url", "--push", "--all", "origin"], {
    cwd,
    timeoutMs: 15000,
    redactOutput: true,
  });
  if (fetch.code !== 0 || push.code !== 0) {
    return { ok: false, reason: "Could not read the work copy origin." };
  }
  const local = await readConfigScope(cardId, cwd, "--local");
  const worktree = await readConfigScope(cardId, cwd, "--worktree");
  const configGuard = assessLocalConfig([local, worktree]);
  if (!configGuard.ok) return configGuard;
  return evaluateRemoteGuard({
    fetchUrls: fetch.stdout,
    pushUrls: push.stdout,
  });
}

export function applyReservation(state, cardId, { dailyCap, today }) {
  const fresh = state.cards.find((item) => item.id === cardId);
  if (!fresh) return { ok: false, status: 404, error: "Card not found." };
  if (fresh.locked || fresh.runStatus === "running") {
    return { ok: false, status: 409, error: "This card already started a run." };
  }
  const count = runsOnDay(state, today);
  if (count >= dailyCap) {
    return { ok: false, status: 409, error: `Daily run cap (${dailyCap}) is reached.` };
  }
  const previous = {
    column: fresh.column,
    locked: fresh.locked,
    runStatus: fresh.runStatus,
    message: fresh.message,
    outOfScopePaths: fresh.outOfScopePaths,
  };
  state.usage = { date: today, count: count + 1 };
  fresh.locked = true;
  fresh.column = "in_progress";
  fresh.runStatus = "running";
  fresh.message = null;
  fresh.outOfScopePaths = [];
  fresh.updatedAt = new Date().toISOString();
  return { ok: true, previous, today };
}

export function rollbackReservation(state, cardId, previous, today) {
  const card = state.cards.find((item) => item.id === cardId);
  if (!card) return { ok: false, error: "Card not found." };
  const prior = previous || {};
  card.locked = false;
  if (Object.prototype.hasOwnProperty.call(prior, "column")) card.column = prior.column;
  if (Object.prototype.hasOwnProperty.call(prior, "runStatus")) card.runStatus = prior.runStatus;
  if (Object.prototype.hasOwnProperty.call(prior, "message")) card.message = prior.message;
  if (Object.prototype.hasOwnProperty.call(prior, "outOfScopePaths")) {
    card.outOfScopePaths = prior.outOfScopePaths;
  }
  card.updatedAt = new Date().toISOString();
  if (state.usage && state.usage.date === today && state.usage.count > 0) {
    state.usage.count -= 1;
  }
  return { ok: true };
}

async function reserveRun(cardId, config) {
  const today = localDay();
  return mutateState((current) => applyReservation(current, cardId, { dailyCap: config.dailyCap, today }));
}

async function rollbackReservedRun(cardId, previous, today) {
  await mutateState((state) => rollbackReservation(state, cardId, previous, today));
}

async function prepareAndSpawn(cardId) {
  const config = loadConfig();
  const state = await readState();
  const card = state.cards.find((item) => item.id === cardId);
  if (!card) return { ok: false, status: 404, error: "Card not found." };

  let realWorkCopyPath = config.workCopyPath;
  if (config.workCopyPath && !pathContainsLumen(config.workCopyPath)) {
    try {
      realWorkCopyPath = fs.realpathSync(config.workCopyPath);
    } catch {
      realWorkCopyPath = config.workCopyPath;
    }
  }

  const limits = evaluateStartGuards({
    agentsEnabled: config.agentsEnabled,
    workCopyPath: config.workCopyPath,
    realWorkCopyPath,
    skipOriginCheck: true,
    locked: card.locked,
    anotherRunning: state.cards.some((item) => item.runStatus === "running"),
    runsToday: runsOnDay(state),
    dailyCap: config.dailyCap,
  });
  if (!limits.ok) return { ok: false, status: 409, error: limits.reason };

  const remoteGuard = await readOriginGuard(cardId, config.workCopyPath);
  if (!remoteGuard.ok) return { ok: false, status: 409, error: remoteGuard.reason };

  const branch = branchFor(cardId);
  const worktreePath = path.join(
    path.dirname(path.resolve(config.workCopyPath)),
    "feedback-board-worktrees",
    cardId,
  );
  if (pathContainsLumen(worktreePath)) {
    return { ok: false, status: 409, error: "Work copy path contains Lumen." };
  }

  appendLog(cardId, `Run for card ${cardId}\nWork copy: ${config.workCopyPath}\n`);
  const fetched = await logged(cardId, "git", ["fetch", "origin", "main"], {
    cwd: config.workCopyPath,
    timeoutMs: 120000,
  });
  if (fetched.code !== 0) {
    return { ok: false, status: 409, error: clip(fetched.stderr || "git fetch origin main failed.") };
  }

  const base = await logged(cardId, "git", ["rev-parse", "origin/main"], {
    cwd: config.workCopyPath,
    timeoutMs: 15000,
  });
  const baseSha = base.code === 0 ? base.stdout.trim() : "";
  if (!SHA.test(baseSha)) {
    return { ok: false, status: 409, error: "Could not pin origin/main." };
  }

  const added = await logged(
    cardId,
    "git",
    ["worktree", "add", "-b", branch, worktreePath, baseSha],
    { cwd: config.workCopyPath, timeoutMs: 120000 },
  );
  if (added.code !== 0) {
    return { ok: false, status: 409, error: clip(added.stderr || "git worktree add failed.") };
  }

  const reserved = await reserveRun(cardId, config);
  if (!reserved.ok) return reserved;

  const prompt = buildAgentPrompt(card);
  appendLog(
    cardId,
    `\n$ ${config.grokCommand} -p <fenced card> --output-format json --max-turns 40 --always-approve --sandbox strict --deny ...\n${prompt}\n`,
  );
  const child = spawnGrok({
    command: config.grokCommand,
    prompt,
    worktreePath,
    env: scrubAgentEnv(process.env),
  });
  const stopFlag = { stopped: false };
  let accepted = false;
  let exitResult = null;
  const handleExit = (code, signal) => {
    if (!accepted) {
      exitResult = { code, signal };
      return;
    }
    processes.delete(cardId);
    const release = () => {
      if (runningCardId === cardId) runningCardId = null;
    };
    if (stopFlag.stopped) {
      release();
      void markCard(cardId, { runStatus: "stopped", message: "Run stopped." });
      return;
    }
    if (code !== 0) {
      release();
      void markCard(cardId, {
        runStatus: "error",
        message: `The run exited with code ${code ?? "null"}${signal ? ` (${signal})` : ""}.`,
      });
      return;
    }
    void finishRun(cardId, worktreePath, branch, baseSha)
      .catch((error) => markCard(cardId, { runStatus: "error", message: clip(error.message) }))
      .finally(release);
  };
  child.stdout?.on("data", (chunk) => appendLog(cardId, chunk.toString()));
  child.stderr?.on("data", (chunk) => appendLog(cardId, chunk.toString()));
  child.on("error", (error) => appendLog(cardId, `Process error: ${error.message}\n`));
  child.on("close", handleExit);

  const spawned = await new Promise((resolve) => {
    child.once("spawn", () => resolve(true));
    child.once("error", () => resolve(false));
  });
  if (!spawned) {
    killProcessGroup(child, "SIGKILL");
    await rollbackReservedRun(cardId, reserved.previous, reserved.today || localDay());
    return { ok: false, status: 409, error: `Could not start ${config.grokCommand}.` };
  }

  accepted = true;
  processes.set(cardId, { child, stopFlag });
  if (exitResult) handleExit(exitResult.code, exitResult.signal);
  return { ok: true, spawned: true };
}

async function requireOk(cardId, result, fallback) {
  if (result.code === 0) return result;
  const message = clip(result.stderr || result.stdout || fallback);
  appendLog(cardId, `${message}\n`);
  throw new Error(message);
}

async function gitOk(cardId, args, cwd, timeoutMs, fallback, env) {
  return requireOk(cardId, await logged(cardId, "git", args, { cwd, timeoutMs, env }), fallback);
}

async function localGitIdentity(cardId, cwd) {
  const read = async (key) => {
    const result = await logged(cardId, "git", ["config", "--local", "--get", key], {
      cwd,
      timeoutMs: 15000,
      redactOutput: true,
    });
    return result.code === 0 ? result.stdout : "";
  };
  return {
    name: await read("user.name"),
    email: await read("user.email"),
  };
}

async function collectSymlinks(cardId, cwd, baseSha, head, untrackedStdout) {
  const ranged = await gitOk(cardId, gateRawArgs(baseSha, head), cwd, 20000, "git diff failed.");
  const dirty = await gitOk(cardId, ["diff", "--raw", "--no-renames"], cwd, 20000, "git diff failed.");
  const staged = await gitOk(
    cardId,
    ["diff", "--raw", "--cached", "--no-renames"],
    cwd,
    20000,
    "git diff failed.",
  );
  return [
    ...symlinkPathsFromRaw(ranged.stdout),
    ...symlinkPathsFromRaw(dirty.stdout),
    ...symlinkPathsFromRaw(staged.stdout),
    ...symlinkPathsOnDisk(cwd, listChangedPaths(untrackedStdout)),
  ];
}

async function changedPaths(cardId, cwd, baseSha, head) {
  const diff = await gitOk(cardId, gateDiffArgs(baseSha, head), cwd, 20000, "git diff failed.");
  const dirty = await gitOk(
    cardId,
    ["diff", "--name-only", "--no-renames"],
    cwd,
    20000,
    "git diff failed.",
  );
  const staged = await gitOk(
    cardId,
    ["diff", "--name-only", "--cached", "--no-renames"],
    cwd,
    20000,
    "git diff failed.",
  );
  const untracked = await gitOk(
    cardId,
    ["ls-files", "--others", "--exclude-standard"],
    cwd,
    20000,
    "Could not list untracked files.",
  );
  const paths = listChangedPaths(diff.stdout, dirty.stdout, staged.stdout, untracked.stdout);
  const links = await collectSymlinks(cardId, cwd, baseSha, head, untracked.stdout);
  return {
    paths,
    blocked: findOutOfScopePaths(paths, links),
    committedPaths: listChangedPaths(diff.stdout),
    dirty: dirty.stdout.trim(),
    staged: staged.stdout.trim(),
    untracked: untracked.stdout.trim(),
  };
}

async function markOutOfScope(cardId, paths, blocked) {
  appendLog(cardId, `Changed paths:\n${paths.join("\n") || "(none)"}\n`);
  appendLog(cardId, `Out of scope:\n${blocked.join("\n")}\nNo pull request opened.\n`);
  await markCard(cardId, {
    column: "in_progress",
    runStatus: "out_of_scope",
    outOfScopePaths: blocked,
    message: "Changed files are outside the allowed folders. No pull request was opened.",
  });
}

async function requireCardHead(cardId, cwd, branch) {
  const head = await gitOk(cardId, ["rev-parse", "HEAD"], cwd, 15000, "Could not read HEAD.");
  const branchRef = await gitOk(
    cardId,
    ["rev-parse", `refs/heads/${branch}`],
    cwd,
    15000,
    "Could not read the card branch.",
  );
  const symbolic = await logged(cardId, "git", ["symbolic-ref", "--quiet", "HEAD"], {
    cwd,
    timeoutMs: 15000,
  });
  const verdict = assertHeadOnBranch({
    headSha: head.stdout.trim(),
    branchSha: branchRef.stdout.trim(),
    branch,
    symbolicHead: symbolic.code === 0 ? symbolic.stdout.trim() : "",
  });
  if (!verdict.ok) throw new Error(verdict.reason);
  return head.stdout.trim();
}

async function finishRun(cardId, worktreePath, branch, baseSha) {
  appendLog(cardId, "\nChecking changed files.\n");
  await requireCardHead(cardId, worktreePath, branch);
  const first = await changedPaths(cardId, worktreePath, baseSha, "HEAD");
  appendLog(cardId, `Changed paths:\n${first.paths.join("\n") || "(none)"}\n`);
  if (first.blocked.length) {
    await markOutOfScope(cardId, first.paths, first.blocked);
    return;
  }

  const status = await gitOk(
    cardId,
    ["status", "--porcelain", "--", "apps/thedailylumen", "apps/feedback-board"],
    worktreePath,
    20000,
    "git status failed.",
  );
  if (status.stdout.trim()) {
    await gitOk(
      cardId,
      ["add", "--", "apps/thedailylumen", "apps/feedback-board"],
      worktreePath,
      20000,
      "git add failed.",
    );
    const identity = await localGitIdentity(cardId, worktreePath);
    const text = pullRequestText(cardId, first.paths);
    await gitOk(
      cardId,
      commitArgs(text.message, identity),
      worktreePath,
      20000,
      "git commit failed.",
      boardGitEnv(),
    );
  }

  const finalSha = await requireCardHead(cardId, worktreePath, branch);
  const second = await changedPaths(cardId, worktreePath, baseSha, finalSha);
  appendLog(cardId, `Re-gated ${baseSha}..${finalSha}\n${second.paths.join("\n") || "(none)"}\n`);
  if (second.blocked.length) {
    await markOutOfScope(cardId, second.paths, second.blocked);
    return;
  }
  if (second.dirty || second.staged || second.untracked) {
    throw new Error("The worktree changed after the commit. No pull request was opened.");
  }
  if (finalSha.toLowerCase() === baseSha.toLowerCase()) {
    await markCard(cardId, {
      runStatus: "error",
      message: "Run finished with no changes. No pull request was opened.",
    });
    return;
  }

  const confirmed = await requireCardHead(cardId, worktreePath, branch);
  if (confirmed.toLowerCase() !== finalSha.toLowerCase()) {
    throw new Error("HEAD moved after the gate.");
  }
  const remoteGuard = await readOriginGuard(cardId, worktreePath);
  if (!remoteGuard.ok) throw new Error(remoteGuard.reason);

  await gitOk(cardId, pushArgs(finalSha, branch), worktreePath, 120000, "git push failed.", boardGitEnv());

  const text = pullRequestText(cardId, second.committedPaths);
  const created = await requireOk(
    cardId,
    await logged(
      cardId,
      "gh",
      [
        "pr",
        "create",
        "--draft",
        "--repo",
        "ixefKos/Grok",
        "--base",
        "main",
        "--head",
        branch,
        "--title",
        text.title,
        "--body",
        text.body,
      ],
      { cwd: worktreePath, timeoutMs: 60000 },
    ),
    "gh pr create failed.",
  );
  const prUrl = created.stdout
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1);
  if (!prUrl || !PR_URL.test(prUrl)) {
    throw new Error("gh pr create did not return a draft pull request URL.");
  }
  await markCard(cardId, {
    column: "pr",
    runStatus: "opened",
    prUrl,
    message: null,
    outOfScopePaths: [],
  });
}

export function stopAllRuns() {
  for (const active of processes.values()) {
    active.stopFlag.stopped = true;
    killProcessGroup(active.child, "SIGKILL");
  }
}

export function stopRun(cardId) {
  const active = processes.get(cardId);
  if (!active) return { ok: false, status: 409, error: "This card has no running process." };
  active.stopFlag.stopped = true;
  killProcessGroup(active.child, "SIGTERM");
  const timer = setTimeout(() => {
    if (processes.get(cardId) === active && active.child.exitCode === null && active.child.signalCode === null) {
      killProcessGroup(active.child, "SIGKILL");
    }
  }, 2000);
  timer.unref();
  active.child.once("close", () => clearTimeout(timer));
  return { ok: true };
}
