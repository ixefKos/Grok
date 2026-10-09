import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { appRoot, loadConfig } from "./config.js";
import { runProcess } from "./exec.js";
import { assessWorkCopyPath, evaluateStartGuards, findOutOfScopePaths, listChangedPaths, pathContainsLumen } from "./guard.js";
import { buildAgentPrompt } from "./prompt.js";
import { mutateState, readState } from "./store.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
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
    onData: (chunk) => appendLog(cardId, chunk),
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

  const pathCheck = assessWorkCopyPath(config.workCopyPath, realWorkCopyPath);
  let originUrl = "";
  if (pathCheck.ok) {
    let remote;
    try {
      remote = await runProcess("git", ["remote", "get-url", "origin"], {
        cwd: config.workCopyPath,
        timeoutMs: 15000,
      });
    } catch {
      return { ok: false, status: 409, error: "Could not read the work copy origin." };
    }
    if (remote.code !== 0) {
      return { ok: false, status: 409, error: "Could not read the work copy origin." };
    }
    originUrl = remote.stdout.trim();
  }

  const verdict = evaluateStartGuards({
    agentsEnabled: config.agentsEnabled,
    workCopyPath: config.workCopyPath,
    realWorkCopyPath,
    originUrl,
    locked: card.locked,
    anotherRunning: state.cards.some((item) => item.runStatus === "running"),
    runsToday: runsOnDay(state),
    dailyCap: config.dailyCap,
  });
  if (!verdict.ok) return { ok: false, status: 409, error: verdict.reason };

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
  const added = await logged(
    cardId,
    "git",
    ["worktree", "add", "-b", branch, worktreePath, "origin/main"],
    { cwd: config.workCopyPath, timeoutMs: 120000 },
  );
  if (added.code !== 0) {
    return { ok: false, status: 409, error: clip(added.stderr || "git worktree add failed.") };
  }

  const prompt = buildAgentPrompt(card);
  appendLog(
    cardId,
    `\n$ ${config.grokCommand} -p <card prompt> --output-format json --max-turns 40 --always-approve\n${prompt}\n`,
  );
  const child = spawn(
    config.grokCommand,
    ["-p", prompt, "--output-format", "json", "--max-turns", "40", "--always-approve"],
    { cwd: worktreePath, shell: false, env: process.env },
  );
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
    void finishRun(cardId, worktreePath, branch)
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
    return { ok: false, status: 409, error: `Could not start ${config.grokCommand}.` };
  }

  const reserved = await mutateState((current) => {
    const fresh = current.cards.find((item) => item.id === cardId);
    if (!fresh) return { ok: false, status: 404, error: "Card not found." };
    if (fresh.locked || fresh.runStatus === "running") {
      return { ok: false, status: 409, error: "This card already started a run." };
    }
    const today = localDay();
    const count = runsOnDay(current, today);
    if (count >= config.dailyCap) {
      return { ok: false, status: 409, error: `Daily run cap (${config.dailyCap}) is reached.` };
    }
    current.usage = { date: today, count: count + 1 };
    fresh.locked = true;
    fresh.column = "in_progress";
    fresh.runStatus = "running";
    fresh.message = null;
    fresh.outOfScopePaths = [];
    fresh.updatedAt = new Date().toISOString();
  });
  if (!reserved.ok) {
    stopFlag.stopped = true;
    child.kill("SIGTERM");
    return reserved;
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

async function finishRun(cardId, worktreePath, branch) {
  appendLog(cardId, "\nChecking changed files.\n");
  const diff = await requireOk(
    cardId,
    await logged(cardId, "git", ["diff", "--name-only", "origin/main...HEAD"], {
      cwd: worktreePath,
      timeoutMs: 20000,
    }),
    "git diff failed.",
  );
  const dirty = await requireOk(
    cardId,
    await logged(cardId, "git", ["diff", "--name-only"], { cwd: worktreePath, timeoutMs: 20000 }),
    "git diff failed.",
  );
  const staged = await requireOk(
    cardId,
    await logged(cardId, "git", ["diff", "--name-only", "--cached"], {
      cwd: worktreePath,
      timeoutMs: 20000,
    }),
    "git diff failed.",
  );
  const untracked = await requireOk(
    cardId,
    await logged(cardId, "git", ["ls-files", "--others", "--exclude-standard"], {
      cwd: worktreePath,
      timeoutMs: 20000,
    }),
    "Could not list untracked files.",
  );
  const paths = listChangedPaths(diff.stdout, dirty.stdout, staged.stdout, untracked.stdout);
  const blocked = findOutOfScopePaths(paths);
  appendLog(cardId, `Changed paths:\n${paths.join("\n") || "(none)"}\n`);
  if (blocked.length) {
    appendLog(cardId, `Out of scope:\n${blocked.join("\n")}\nNo pull request opened.\n`);
    await markCard(cardId, {
      column: "in_progress",
      runStatus: "out_of_scope",
      outOfScopePaths: blocked,
      message: "Changed files are outside the allowed folders. No pull request was opened.",
    });
    return;
  }

  const status = await requireOk(
    cardId,
    await logged(cardId, "git", ["status", "--porcelain", "--", "apps/thedailylumen", "apps/feedback-board"], {
      cwd: worktreePath,
      timeoutMs: 20000,
    }),
    "git status failed.",
  );
  if (status.stdout.trim()) {
    await requireOk(
      cardId,
      await logged(cardId, "git", ["add", "--", "apps/thedailylumen", "apps/feedback-board"], {
        cwd: worktreePath,
        timeoutMs: 20000,
      }),
      "git add failed.",
    );
    const current = await readState();
    const card = current.cards.find((item) => item.id === cardId);
    const title = (card?.title || cardId).replace(/[\r\n]/g, " ").slice(0, 80);
    await requireOk(
      cardId,
      await logged(cardId, "git", ["commit", "-m", `feedback: ${title}`], {
        cwd: worktreePath,
        timeoutMs: 20000,
      }),
      "git commit failed.",
    );
  }

  const head = await requireOk(
    cardId,
    await logged(cardId, "git", ["rev-parse", "HEAD"], { cwd: worktreePath, timeoutMs: 15000 }),
    "Could not read HEAD.",
  );
  const base = await requireOk(
    cardId,
    await logged(cardId, "git", ["rev-parse", "origin/main"], { cwd: worktreePath, timeoutMs: 15000 }),
    "Could not read origin/main.",
  );
  if (head.stdout.trim() === base.stdout.trim()) {
    await markCard(cardId, {
      runStatus: "error",
      message: "Run finished with no changes. No pull request was opened.",
    });
    return;
  }

  await requireOk(
    cardId,
    await logged(cardId, "git", ["push", "-u", "origin", branch], {
      cwd: worktreePath,
      timeoutMs: 120000,
    }),
    "git push failed.",
  );

  const current = await readState();
  const card = current.cards.find((item) => item.id === cardId);
  const title = (card?.title || `Feedback ${cardId}`).replace(/[\r\n]/g, " ").slice(0, 120);
  const body = [
    card?.notes || "Draft from the local feedback board.",
    "",
    "Opened as a draft by the local feedback board. Nothing in this flow merges the pull request.",
  ].join("\n");
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
        title,
        "--body",
        body,
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
    active.child.kill("SIGTERM");
  }
}

export function stopRun(cardId) {
  const active = processes.get(cardId);
  if (!active) return { ok: false, status: 409, error: "This card has no running process." };
  active.stopFlag.stopped = true;
  active.child.kill("SIGTERM");
  const timer = setTimeout(() => {
    if (processes.get(cardId) === active && active.child.exitCode === null && active.child.signalCode === null) {
      active.child.kill("SIGKILL");
    }
  }, 2000);
  active.child.once("close", () => clearTimeout(timer));
  return { ok: true };
}
