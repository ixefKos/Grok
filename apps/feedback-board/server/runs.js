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
  failedSpawnCleanupArgs,
  findRegisteredGitDir,
  porcelainListsWorktree,
  postRunGitPlan,
  runIfPinned,
  withBoardGitArgs,
} from "./git-pin.js";
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

async function boardGit(cardId, args, options = {}) {
  return logged(cardId, "git", withBoardGitArgs(args), options);
}

function gitdirRejection(reason) {
  const error = new Error(reason || "Worktree gitdir was rewritten.");
  error.gitdirRejected = true;
  return error;
}

async function pinnedGit(cardId, args, pin, timeoutMs, env, redactOutput = false) {
  const plan = postRunGitPlan({
    worktreePath: pin.worktreePath,
    gitDir: pin.gitDir,
    args,
    env,
  });
  const executed = await runIfPinned(plan, (gitArgs, gitEnv) =>
    logged(cardId, "git", gitArgs, {
      cwd: pin.worktreePath,
      timeoutMs,
      env: gitEnv,
      redactOutput,
    }),
  );
  if (!executed.ran) throw gitdirRejection(executed.reason);
  return executed.result;
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

async function readConfigScope(cardId, scope, cwd, pin) {
  const args = ["config", scope, "--get-regexp", LOCAL_CONFIG_PATTERN];
  if (pin) return pinnedGit(cardId, args, pin, 15000, undefined, true);
  return boardGit(cardId, args, { cwd, timeoutMs: 15000, redactOutput: true });
}

async function readOriginGuard(cardId, cwd, pin = null) {
  const run = (args) => {
    if (pin) return pinnedGit(cardId, args, pin, 15000, undefined, true);
    return boardGit(cardId, args, { cwd, timeoutMs: 15000, redactOutput: true });
  };
  const fetch = await run(["remote", "get-url", "--all", "origin"]);
  const push = await run(["remote", "get-url", "--push", "--all", "origin"]);
  if (fetch.code !== 0 || push.code !== 0) {
    return { ok: false, reason: "Could not read the work copy origin." };
  }
  const local = await readConfigScope(cardId, "--local", cwd, pin);
  const worktree = await readConfigScope(cardId, "--worktree", cwd, pin);
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

async function cleanupFailedWorktree(cardId, workCopy, worktreePath, branch) {
  const args = failedSpawnCleanupArgs(worktreePath, branch);
  await boardGit(cardId, args.remove, { cwd: workCopy, timeoutMs: 120000 });
  await boardGit(cardId, args.branch, { cwd: workCopy, timeoutMs: 15000 });
}

async function recordWorktreeGitDir(cardId, workCopy, worktreePath) {
  const common = await boardGit(cardId, ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
    cwd: workCopy,
    timeoutMs: 15000,
  });
  if (common.code !== 0) return { ok: false, reason: "Could not resolve the worktree git dir." };
  const list = await boardGit(cardId, ["worktree", "list", "--porcelain"], {
    cwd: workCopy,
    timeoutMs: 15000,
  });
  if (list.code !== 0 || !porcelainListsWorktree(list.stdout, worktreePath)) {
    return { ok: false, reason: "Could not resolve the worktree git dir." };
  }
  const gitDir = findRegisteredGitDir(common.stdout.trim(), worktreePath);
  if (!gitDir) return { ok: false, reason: "Could not resolve the worktree git dir." };
  return { ok: true, gitDir };
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
  const fetched = await boardGit(cardId, ["fetch", "origin", "main"], {
    cwd: config.workCopyPath,
    timeoutMs: 120000,
  });
  if (fetched.code !== 0) {
    return { ok: false, status: 409, error: clip(fetched.stderr || "git fetch origin main failed.") };
  }

  const base = await boardGit(cardId, ["rev-parse", "origin/main"], {
    cwd: config.workCopyPath,
    timeoutMs: 15000,
  });
  const baseSha = base.code === 0 ? base.stdout.trim() : "";
  if (!SHA.test(baseSha)) {
    return { ok: false, status: 409, error: "Could not pin origin/main." };
  }

  const added = await boardGit(cardId, ["worktree", "add", "-b", branch, worktreePath, baseSha], {
    cwd: config.workCopyPath,
    timeoutMs: 120000,
  });
  if (added.code !== 0) {
    return { ok: false, status: 409, error: clip(added.stderr || "git worktree add failed.") };
  }

  const recorded = await recordWorktreeGitDir(cardId, config.workCopyPath, worktreePath);
  if (!recorded.ok) {
    await cleanupFailedWorktree(cardId, config.workCopyPath, worktreePath, branch);
    return { ok: false, status: 409, error: recorded.reason };
  }
  const gitDir = recorded.gitDir;

  const reserved = await reserveRun(cardId, config);
  if (!reserved.ok) {
    await cleanupFailedWorktree(cardId, config.workCopyPath, worktreePath, branch);
    return reserved;
  }

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
    void finishRun(cardId, worktreePath, branch, baseSha, gitDir)
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
    await cleanupFailedWorktree(cardId, config.workCopyPath, worktreePath, branch);
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

async function pinnedOk(cardId, args, pin, timeoutMs, fallback, env) {
  return requireOk(cardId, await pinnedGit(cardId, args, pin, timeoutMs, env), fallback);
}

async function localGitIdentity(cardId, pin) {
  const read = async (key) => {
    const result = await pinnedGit(cardId, ["config", "--local", "--get", key], pin, 15000, undefined, true);
    return result.code === 0 ? result.stdout : "";
  };
  return {
    name: await read("user.name"),
    email: await read("user.email"),
  };
}

async function collectSymlinks(cardId, pin, baseSha, head, untrackedStdout) {
  const ranged = await pinnedOk(cardId, gateRawArgs(baseSha, head), pin, 20000, "git diff failed.");
  const dirty = await pinnedOk(cardId, ["diff", "--raw", "--no-renames"], pin, 20000, "git diff failed.");
  const staged = await pinnedOk(
    cardId,
    ["diff", "--raw", "--cached", "--no-renames"],
    pin,
    20000,
    "git diff failed.",
  );
  return [
    ...symlinkPathsFromRaw(ranged.stdout),
    ...symlinkPathsFromRaw(dirty.stdout),
    ...symlinkPathsFromRaw(staged.stdout),
    ...symlinkPathsOnDisk(pin.worktreePath, listChangedPaths(untrackedStdout)),
  ];
}

async function changedPaths(cardId, pin, baseSha, head) {
  const diff = await pinnedOk(cardId, gateDiffArgs(baseSha, head), pin, 20000, "git diff failed.");
  const dirty = await pinnedOk(cardId, ["diff", "--name-only", "--no-renames"], pin, 20000, "git diff failed.");
  const staged = await pinnedOk(
    cardId,
    ["diff", "--name-only", "--cached", "--no-renames"],
    pin,
    20000,
    "git diff failed.",
  );
  const untracked = await pinnedOk(
    cardId,
    ["ls-files", "--others", "--exclude-standard"],
    pin,
    20000,
    "Could not list untracked files.",
  );
  const paths = listChangedPaths(diff.stdout, dirty.stdout, staged.stdout, untracked.stdout);
  const links = await collectSymlinks(cardId, pin, baseSha, head, untracked.stdout);
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

async function requireCardHead(cardId, pin, branch) {
  const head = await pinnedOk(cardId, ["rev-parse", "HEAD"], pin, 15000, "Could not read HEAD.");
  const branchRef = await pinnedOk(
    cardId,
    ["rev-parse", `refs/heads/${branch}`],
    pin,
    15000,
    "Could not read the card branch.",
  );
  const symbolic = await pinnedGit(cardId, ["symbolic-ref", "--quiet", "HEAD"], pin, 15000);
  const verdict = assertHeadOnBranch({
    headSha: head.stdout.trim(),
    branchSha: branchRef.stdout.trim(),
    branch,
    symbolicHead: symbolic.code === 0 ? symbolic.stdout.trim() : "",
  });
  if (!verdict.ok) throw new Error(verdict.reason);
  return head.stdout.trim();
}

async function markGitdirRejected(cardId, reason) {
  appendLog(cardId, `${reason}\n`);
  await markCard(cardId, {
    column: "in_progress",
    runStatus: "out_of_scope",
    outOfScopePaths: [".git"],
    message: reason,
  });
}

async function finishRun(cardId, worktreePath, branch, baseSha, gitDir) {
  const pin = { worktreePath, gitDir };
  try {
    await finishRunPinned(cardId, pin, branch, baseSha);
  } catch (error) {
    if (error && error.gitdirRejected) {
      await markGitdirRejected(cardId, error.message);
      return;
    }
    throw error;
  }
}

async function finishRunPinned(cardId, pin, branch, baseSha) {
  const { worktreePath } = pin;
  appendLog(cardId, "\nChecking changed files.\n");
  await requireCardHead(cardId, pin, branch);
  const first = await changedPaths(cardId, pin, baseSha, "HEAD");
  appendLog(cardId, `Changed paths:\n${first.paths.join("\n") || "(none)"}\n`);
  if (first.blocked.length) {
    await markOutOfScope(cardId, first.paths, first.blocked);
    return;
  }

  const status = await pinnedOk(
    cardId,
    ["status", "--porcelain", "--", "apps/thedailylumen", "apps/feedback-board"],
    pin,
    20000,
    "git status failed.",
  );
  if (status.stdout.trim()) {
    await pinnedOk(
      cardId,
      ["add", "--", "apps/thedailylumen", "apps/feedback-board"],
      pin,
      20000,
      "git add failed.",
    );
    const identity = await localGitIdentity(cardId, pin);
    const text = pullRequestText(cardId, first.paths);
    await pinnedOk(cardId, commitArgs(text.message, identity), pin, 20000, "git commit failed.", boardGitEnv());
  }

  const finalSha = await requireCardHead(cardId, pin, branch);
  const second = await changedPaths(cardId, pin, baseSha, finalSha);
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

  const confirmed = await requireCardHead(cardId, pin, branch);
  if (confirmed.toLowerCase() !== finalSha.toLowerCase()) {
    throw new Error("HEAD moved after the gate.");
  }
  const remoteGuard = await readOriginGuard(cardId, worktreePath, pin);
  if (!remoteGuard.ok) throw new Error(remoteGuard.reason);

  await pinnedOk(cardId, pushArgs(finalSha, branch), pin, 120000, "git push failed.", boardGitEnv());

  const text = pullRequestText(cardId, second.committedPaths);
  const ghPlan = postRunGitPlan({ worktreePath, gitDir: pin.gitDir, args: [], env: {} });
  if (!ghPlan.ok) throw gitdirRejection(ghPlan.reason);
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
      {
        cwd: worktreePath,
        timeoutMs: 60000,
        env: { GIT_DIR: ghPlan.env.GIT_DIR, GIT_WORK_TREE: ghPlan.env.GIT_WORK_TREE },
      },
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
