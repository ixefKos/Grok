import crypto from "node:crypto";
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
  prepareAgentSandbox,
  reapAgentGroup,
  scrubAgentEnv,
  spawnGrok,
} from "./agent-launch.js";
import {
  cleanupVerdict,
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
  pathIsTempOrGrok,
  symlinkPathsFromRaw,
  symlinkPathsOnDisk,
} from "./guard.js";
import { agentTreeUsers, killMarkedProcesses } from "./tree-idle.js";
import {
  applyTreeChanges,
  baseContentHashes,
  freshWorktreePath,
  isAllowedRel,
  outsideDrift,
  planTreeChanges,
  readAgentTree,
  rejectMovedIn,
  removeAgentTree,
  snapshotAgentTree,
} from "./tree-gate.js";
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

function appendLog(cardId, text, root) {
  const file = logFile(cardId, root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, text);
}

function clip(text) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  if (!clean) return "The run failed.";
  return clean.length > 400 ? `${clean.slice(0, 400)}…` : clean;
}

async function logged(cardId, command, args, options = {}) {
  appendLog(cardId, `\n$ ${command} ${args.join(" ")}\n`, options.logRoot);
  return runProcess(command, args, {
    ...options,
    onData: options.redactOutput ? () => {} : (chunk) => appendLog(cardId, chunk, options.logRoot),
  });
}

async function boardGit(cardId, args, options = {}) {
  return logged(cardId, "git", withBoardGitArgs(args), {
    ...options,
    env: { GIT_DIR: null, GIT_WORK_TREE: null, ...(options.env || {}) },
  });
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
      logRoot: pin.logRoot,
    }),
  );
  if (!executed.ran) throw gitdirRejection(executed.reason);
  return executed.result;
}

async function markCard(cardId, fields, root) {
  await mutateState((state) => {
    const card = state.cards.find((item) => item.id === cardId);
    if (!card) return { ok: false, error: "Card not found." };
    Object.assign(card, fields, { updatedAt: new Date().toISOString() });
  }, root);
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

async function runCleanup(cardId, workCopy, steps, logRoot) {
  const results = [];
  for (const args of steps) {
    results.push(await boardGit(cardId, args, { cwd: workCopy, timeoutMs: 120000, logRoot }));
  }
  return cleanupVerdict(results);
}

async function cleanupFailedWorktree(cardId, workCopy, worktreePath, branch) {
  const args = failedSpawnCleanupArgs(worktreePath, branch);
  return runCleanup(cardId, workCopy, [args.remove, args.branch, args.prune]);
}

const agentBaselines = new Map();

export function rememberAgentBaseline(cardId, baseline) {
  agentBaselines.set(String(cardId), baseline);
  return baseline;
}

function agentBaseline(cardId, explicit) {
  if (explicit) return explicit;
  return agentBaselines.get(String(cardId)) || null;
}

async function discardWorktreeDirectory(worktreePath, marker) {
  if (!worktreePath) return { ok: true };
  const killed = killMarkedProcesses(marker);
  if (!killed.ok) return { ok: false, reason: killed.reason || "Could not clean up the worktree." };
  return removeAgentTree(worktreePath);
}

async function cleanupPublishTrees(cardId, workCopy, { agentWorktree, freshWorktree, logRoot, marker, sandboxRoot } = {}) {
  const removed = await discardWorktreeDirectory(agentWorktree, marker);
  const sandboxRemoved = await discardWorktreeDirectory(sandboxRoot, marker);
  const steps = [];
  if (freshWorktree && fs.existsSync(freshWorktree)) {
    steps.push(["worktree", "remove", "--force", freshWorktree]);
  }
  steps.push(["worktree", "prune"]);
  const cleaned = await runCleanup(cardId, workCopy, steps, logRoot);
  if (!removed.ok || !sandboxRemoved.ok) return { ok: false, reason: "Could not clean up the worktree." };
  return cleaned;
}

async function recordWorktreeGitDir(cardId, workCopy, worktreePath, logRoot) {
  const common = await boardGit(cardId, ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
    cwd: workCopy,
    timeoutMs: 15000,
    logRoot,
  });
  if (common.code !== 0) return { ok: false, reason: "Could not resolve the worktree git dir." };
  const list = await boardGit(cardId, ["worktree", "list", "--porcelain"], {
    cwd: workCopy,
    timeoutMs: 15000,
    logRoot,
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
  if (pathIsTempOrGrok(worktreePath) || pathIsTempOrGrok(realWorkCopyPath)) {
    return { ok: false, status: 409, error: "Work copy path is under a temporary or Grok directory." };
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
    const cleaned = await cleanupFailedWorktree(cardId, config.workCopyPath, worktreePath, branch);
    const error = cleaned.ok ? recorded.reason : `${recorded.reason} ${cleaned.reason}`;
    return { ok: false, status: 409, error };
  }
  const gitDir = recorded.gitDir;

  const reserved = await reserveRun(cardId, config);
  if (!reserved.ok) {
    const cleaned = await cleanupFailedWorktree(cardId, config.workCopyPath, worktreePath, branch);
    if (!cleaned.ok) return { ok: false, status: 409, error: cleaned.reason };
    return reserved;
  }

  const snap = snapshotAgentTree(worktreePath);
  if (!snap.ok) {
    const cleaned = await cleanupFailedWorktree(cardId, config.workCopyPath, worktreePath, branch);
    await rollbackReservedRun(cardId, reserved.previous, reserved.today || localDay());
    const error = cleaned.ok ? snap.reason : `${snap.reason} ${cleaned.reason}`;
    return { ok: false, status: 409, error };
  }
  const sandbox = prepareAgentSandbox();
  const marker = crypto.randomBytes(16).toString("hex");
  const spawnTime = Date.now() / 1000;
  rememberAgentBaseline(cardId, {
    inodes: snap.inodes,
    spawnTime,
    marker,
    sandboxRoot: sandbox.root,
  });

  const prompt = buildAgentPrompt(card);
  appendLog(
    cardId,
    `\n$ ${config.grokCommand} -p <fenced card> --output-format json --max-turns 40 --always-approve --sandbox strict --deny ...\n${prompt}\n`,
  );
  const child = spawnGrok({
    command: config.grokCommand,
    prompt,
    worktreePath,
    env: scrubAgentEnv(process.env, { home: sandbox.home, tmp: sandbox.tmp, marker }),
    contain: true,
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
      void (async () => {
        try {
          await reapAgentGroup(child.pid);
        } finally {
          release();
          await markCard(cardId, { runStatus: "stopped", message: "Run stopped." });
        }
      })();
      return;
    }
    void (async () => {
      try {
        const reaped = await reapAgentGroup(child.pid);
        if (!reaped.ok) {
          await markCard(cardId, { runStatus: "error", message: reaped.reason });
          return;
        }
        if (code !== 0) {
          await markCard(cardId, {
            runStatus: "error",
            message: `The run exited with code ${code ?? "null"}${signal ? ` (${signal})` : ""}.`,
          });
          return;
        }
        const baseline = agentBaseline(cardId);
        if (baseline && baseline.marker) {
          const killed = killMarkedProcesses(baseline.marker);
          if (!killed.ok) {
            await markCard(cardId, {
              column: "in_progress",
              runStatus: "out_of_scope",
              outOfScopePaths: killed.killed || [],
              message: killed.reason,
            });
            return;
          }
        }
        const busy = agentTreeUsers(worktreePath);
        if (!busy.ok) {
          await markCard(cardId, {
            column: "in_progress",
            runStatus: "out_of_scope",
            outOfScopePaths: busy.blocked || [],
            message: busy.reason,
          });
          return;
        }
        await finishRun(cardId, worktreePath, config.workCopyPath, branch, baseSha);
      } catch (error) {
        await markCard(cardId, { runStatus: "error", message: clip(error.message) });
      } finally {
        release();
      }
    })();
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
    const cleaned = await cleanupFailedWorktree(cardId, config.workCopyPath, worktreePath, branch);
    await rollbackReservedRun(cardId, reserved.previous, reserved.today || localDay());
    if (!cleaned.ok) {
      await markCard(cardId, { locked: false, runStatus: "error", message: cleaned.reason });
      return { ok: false, status: 409, error: cleaned.reason };
    }
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

async function localGitIdentity(cardId, cwd, logRoot) {
  const read = async (key) => {
    const result = await boardGit(cardId, ["config", "--local", "--get", key], {
      cwd,
      timeoutMs: 15000,
      redactOutput: true,
      logRoot,
    });
    return result.code === 0 ? result.stdout : "";
  };
  return {
    name: await read("user.name"),
    email: await read("user.email"),
  };
}

async function collectSymlinks(cardId, pin, baseSha, head, untrackedStdout) {
  const ranged = await pinnedOk(cardId, gateRawArgs(baseSha, head), pin, 20000, "git diff failed.");
  const dirty = await pinnedOk(
    cardId,
    ["diff", "--raw", "--no-renames", "--ignore-submodules=all"],
    pin,
    20000,
    "git diff failed.",
  );
  const staged = await pinnedOk(
    cardId,
    ["diff", "--raw", "--cached", "--no-renames", "--ignore-submodules=all"],
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
  const dirty = await pinnedOk(
    cardId,
    ["diff", "--name-only", "--no-renames", "--ignore-submodules=all"],
    pin,
    20000,
    "git diff failed.",
  );
  const staged = await pinnedOk(
    cardId,
    ["diff", "--name-only", "--cached", "--no-renames", "--ignore-submodules=all"],
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

async function markOutOfScope(cardId, paths, blocked, root) {
  appendLog(cardId, `Changed paths:\n${paths.join("\n") || "(none)"}\n`, root);
  appendLog(cardId, `Out of scope:\n${blocked.join("\n")}\nNo pull request opened.\n`, root);
  await markCard(
    cardId,
    {
      column: "in_progress",
      runStatus: "out_of_scope",
      outOfScopePaths: blocked,
      message: "Changed files are outside the allowed folders. No pull request was opened.",
    },
    root,
  );
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

async function markGitdirRejected(cardId, reason, root) {
  appendLog(cardId, `${reason}\n`, root);
  await markCard(
    cardId,
    {
      column: "in_progress",
      runStatus: "out_of_scope",
      outOfScopePaths: [".git"],
      message: reason,
    },
    root,
  );
}

async function markTreeRejected(cardId, reason, blocked, root) {
  appendLog(cardId, `${reason}\n`, root);
  await markCard(
    cardId,
    {
      column: "in_progress",
      runStatus: "out_of_scope",
      outOfScopePaths: blocked || [],
      message: reason,
    },
    root,
  );
}

function parseLsTreeZ(buffer) {
  const text = Buffer.isBuffer(buffer) ? buffer.toString("utf8") : String(buffer ?? "");
  const entries = [];
  for (const record of text.split("\0")) {
    if (!record) continue;
    const tab = record.indexOf("\t");
    if (tab < 0) continue;
    const meta = record.slice(0, tab).split(" ");
    const rel = record.slice(tab + 1);
    if (!rel) continue;
    entries.push({ mode: meta[0] || "", type: meta[1] || "", path: rel });
  }
  return entries;
}

async function readBaseSnapshot(cardId, workCopy, baseSha, logRoot) {
  const listed = await boardGit(cardId, ["ls-tree", "-r", "-z", baseSha], {
    cwd: workCopy,
    timeoutMs: 20000,
    logRoot,
  });
  if (listed.code !== 0) throw new Error(clip(listed.stderr || "Could not list the base tree."));
  const entries = parseLsTreeZ(listed.stdoutBuffer);
  const blobs = new Map();
  for (const entry of entries) {
    if (!isAllowedRel(entry.path)) continue;
    if (entry.mode === "120000" || entry.mode === "160000" || entry.type !== "blob") continue;
    const blob = await boardGit(cardId, ["cat-file", "blob", `${baseSha}:${entry.path}`], {
      cwd: workCopy,
      timeoutMs: 20000,
      redactOutput: true,
      logRoot,
    });
    if (blob.code !== 0) throw new Error(clip(blob.stderr || "Could not read a base file."));
    blobs.set(entry.path, blob.stdoutBuffer || Buffer.alloc(0));
  }
  return { paths: entries.map((entry) => entry.path), blobs };
}

function treeRefusal(reason, blocked = []) {
  return { ok: false, rejected: true, reason, blocked };
}

export async function publishAgentTree({
  cardId,
  workCopy,
  agentWorktree,
  branch,
  baseSha,
  push = true,
  openPullRequest = true,
  stateRoot,
  baseline: baselineOption,
} = {}) {
  let freshPath = null;
  let rejection = null;
  const baseline = agentBaseline(cardId, baselineOption);
  const refuse = async (reason, blocked = []) => {
    rejection = reason;
    await markTreeRejected(cardId, reason, blocked, stateRoot);
    return treeRefusal(reason, blocked);
  };
  try {
    appendLog(cardId, "\nChecking the agent tree.\n", stateRoot);
    if (pathContainsLumen(workCopy) || pathContainsLumen(agentWorktree)) {
      return refuse("Work copy path contains Lumen.");
    }
    if (pathIsTempOrGrok(workCopy) || pathIsTempOrGrok(agentWorktree)) {
      return refuse("Work copy path is under a temporary or Grok directory.");
    }
    if (baseline && baseline.marker) {
      const killed = killMarkedProcesses(baseline.marker);
      if (!killed.ok) return refuse(killed.reason, killed.killed || []);
    }
    const busy = agentTreeUsers(agentWorktree);
    if (!busy.ok) return refuse(busy.reason, busy.blocked);
    const base = await readBaseSnapshot(cardId, workCopy, baseSha, stateRoot);
    const inspected = await readAgentTree(agentWorktree, {
      inodes: baseline ? baseline.inodes : [],
      spawnTime: baseline ? baseline.spawnTime : null,
      base: baseContentHashes(base.blobs),
    });
    const busyAfter = agentTreeUsers(agentWorktree);
    if (!busyAfter.ok) return refuse(busyAfter.reason, busyAfter.blocked);
    if (!inspected.ok) return refuse(inspected.reason, inspected.blocked);
    const moved = rejectMovedIn(inspected, baseline, base.blobs);
    if (moved) return refuse(moved.reason, moved.blocked);

    const drift = outsideDrift(inspected.agentFiles, base.paths);
    if (!drift.ok) return refuse(drift.reason, drift.blocked);
    const planned = planTreeChanges(inspected.allowed, base.blobs, [...base.blobs.keys()]);
    if (!planned.ok) return refuse(planned.reason, planned.blocked);
    if (planned.changes.length === 0) {
      await markCard(
        cardId,
        {
          runStatus: "error",
          message: "Run finished with no changes. No pull request was opened.",
        },
        stateRoot,
      );
      return { ok: true, noChanges: true, sha: baseSha };
    }

    freshPath = freshWorktreePath(workCopy, cardId);
    if (pathContainsLumen(freshPath)) return refuse("Work copy path contains Lumen.");
    if (pathIsTempOrGrok(freshPath)) return refuse("Work copy path is under a temporary or Grok directory.");

    const removed = await discardWorktreeDirectory(agentWorktree, baseline && baseline.marker);
    if (!removed.ok) throw new Error(removed.reason || "Could not clean up the worktree.");
    const pruned = await boardGit(cardId, ["worktree", "prune"], {
      cwd: workCopy,
      timeoutMs: 120000,
      logRoot: stateRoot,
    });
    if (pruned.code !== 0) throw new Error("Could not clean up the worktree.");
    fs.mkdirSync(path.dirname(freshPath), { recursive: true });
    const added = await boardGit(cardId, ["worktree", "add", "-B", branch, freshPath, baseSha], {
      cwd: workCopy,
      timeoutMs: 120000,
      logRoot: stateRoot,
    });
    if (added.code !== 0) throw new Error(clip(added.stderr || "Could not create the publish worktree."));
    const recorded = await recordWorktreeGitDir(cardId, workCopy, freshPath, stateRoot);
    if (!recorded.ok) throw new Error(recorded.reason);
    applyTreeChanges(freshPath, planned.changes);
    const published = await finishRunPinned(
      cardId,
      { worktreePath: freshPath, gitDir: recorded.gitDir, logRoot: stateRoot },
      branch,
      baseSha,
      workCopy,
      { push, openPullRequest, stateRoot },
    );
    if (published.blocked) {
      return {
        ok: false,
        rejected: true,
        reason: "Changed files are outside the allowed folders. No pull request was opened.",
        sha: published.sha,
      };
    }
    if (published.noChanges) return { ok: true, noChanges: true, sha: published.sha };
    return { ok: true, sha: published.sha, prUrl: published.prUrl || null };
  } finally {
    const cleaned = await cleanupPublishTrees(cardId, workCopy, {
      agentWorktree,
      freshWorktree: freshPath,
      logRoot: stateRoot,
      marker: baseline && baseline.marker,
      sandboxRoot: baseline && baseline.sandboxRoot,
    });
    if (!cleaned.ok) {
      const message = rejection ? `${rejection} ${cleaned.reason}` : cleaned.reason;
      await markCard(cardId, { message }, stateRoot);
    }
  }
}

async function finishRun(cardId, agentWorktree, workCopy, branch, baseSha) {
  try {
    await publishAgentTree({ cardId, workCopy, agentWorktree, branch, baseSha });
  } catch (error) {
    if (error && error.gitdirRejected) {
      await markGitdirRejected(cardId, error.message);
      return;
    }
    throw error;
  }
}

async function finishRunPinned(cardId, pin, branch, baseSha, workCopy, options = {}) {
  const { push = true, openPullRequest = true, stateRoot } = options;
  const { worktreePath } = pin;
  appendLog(cardId, "\nChecking changed files.\n", stateRoot);
  await requireCardHead(cardId, pin, branch);
  const first = await changedPaths(cardId, pin, baseSha, "HEAD");
  appendLog(cardId, `Changed paths:\n${first.paths.join("\n") || "(none)"}\n`, stateRoot);
  if (first.blocked.length) {
    await markOutOfScope(cardId, first.paths, first.blocked, stateRoot);
    return { sha: null, blocked: true };
  }

  const status = await pinnedOk(
    cardId,
    ["status", "--porcelain", "--ignore-submodules=all", "--", "apps/thedailylumen", "apps/feedback-board"],
    pin,
    20000,
    "git status failed.",
  );
  if (status.stdout.trim()) {
    const specs = [];
    for (const rel of ["apps/thedailylumen", "apps/feedback-board"]) {
      if (fs.existsSync(path.join(worktreePath, rel))) {
        specs.push(rel);
        continue;
      }
      const tracked = await pinnedGit(cardId, ["ls-files", "--", rel], pin, 20000);
      if (tracked.code === 0 && tracked.stdout.trim()) specs.push(rel);
    }
    if (specs.length === 0) throw new Error("git add failed.");
    await pinnedOk(cardId, ["add", "-A", "--", ...specs], pin, 20000, "git add failed.");
    const identity = await localGitIdentity(cardId, workCopy, stateRoot);
    const text = pullRequestText(cardId, first.paths);
    await pinnedOk(cardId, commitArgs(text.message, identity), pin, 20000, "git commit failed.", boardGitEnv());
  }

  const finalSha = await requireCardHead(cardId, pin, branch);
  const second = await changedPaths(cardId, pin, baseSha, finalSha);
  appendLog(cardId, `Re-gated ${baseSha}..${finalSha}\n${second.paths.join("\n") || "(none)"}\n`, stateRoot);
  if (second.blocked.length) {
    await markOutOfScope(cardId, second.paths, second.blocked, stateRoot);
    return { sha: finalSha, blocked: true };
  }
  if (second.dirty || second.staged || second.untracked) {
    throw new Error("The worktree changed after the commit. No pull request was opened.");
  }
  if (finalSha.toLowerCase() === baseSha.toLowerCase()) {
    await markCard(
      cardId,
      {
        runStatus: "error",
        message: "Run finished with no changes. No pull request was opened.",
      },
      stateRoot,
    );
    return { sha: finalSha, noChanges: true };
  }

  const confirmed = await requireCardHead(cardId, pin, branch);
  if (confirmed.toLowerCase() !== finalSha.toLowerCase()) {
    throw new Error("HEAD moved after the gate.");
  }
  if (!push) return { sha: finalSha };

  const remoteGuard = await readOriginGuard(cardId, worktreePath, pin);
  if (!remoteGuard.ok) throw new Error(remoteGuard.reason);

  await pinnedOk(cardId, pushArgs(finalSha, branch), pin, 120000, "git push failed.", boardGitEnv());
  if (!openPullRequest) return { sha: finalSha };

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
        env: boardGitEnv({ GIT_DIR: ghPlan.env.GIT_DIR, GIT_WORK_TREE: ghPlan.env.GIT_WORK_TREE }),
        logRoot: stateRoot,
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
  await markCard(
    cardId,
    {
      column: "pr",
      runStatus: "opened",
      prUrl,
      message: null,
      outOfScopePaths: [],
    },
    stateRoot,
  );
  return { sha: finalSha, prUrl };
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
