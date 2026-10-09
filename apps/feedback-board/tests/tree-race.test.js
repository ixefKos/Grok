import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { agentSpawnPlan, copyGrokAuth, prepareAgentSandbox, scrubAgentEnv } from "../server/agent-launch.js";
import { mutateState, readState } from "../server/store.js";
import { applyTreeChanges, inspectAgentTree, removeAgentTree, snapshotAgentTree } from "../server/tree-gate.js";
import { AGENT_BUSY, LSOF_BIN, RUN_MARKER_ENV, interpretLsofOutput, killMarkedProcesses, lsofUsers, pidsCarryingMarker } from "../server/tree-idle.js";
import { publishAgentTree } from "../server/runs.js";

const SECRET = "FB-RACE-CANARY-9f3c1a7b";
const ITERATIONS = 40;
const CARD_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const BRANCH = `feedback/card-${CARD_ID}`;

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "Feedback Board Test",
  GIT_AUTHOR_EMAIL: "feedback-board-test@example.com",
  GIT_COMMITTER_NAME: "Feedback Board Test",
  GIT_COMMITTER_EMAIL: "feedback-board-test@example.com",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
};

function leaked(result) {
  if (result && result.reason && result.reason.includes(SECRET)) return true;
  if (!result || !result.allowed) return false;
  const needle = Buffer.from(SECRET);
  for (const bytes of result.allowed.values()) {
    if (Buffer.isBuffer(bytes) && bytes.includes(needle)) return true;
  }
  return false;
}

function killChild(child) {
  if (!child || !child.pid) return;
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    try {
      process.kill(child.pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
}

async function git(cwd, args) {
  return execFileSync("git", args, { cwd, env: gitEnv, encoding: "utf8" });
}

describe("agent tree races", { concurrency: 1 }, () => {
  it("never copies a swapped symlink, directory, or renamed name", async (t) => {
    const fileSwap = `
import os, sys
target, secret = sys.argv[1], sys.argv[2]
while True:
    try:
        os.unlink(target)
    except OSError:
        pass
    try:
        os.symlink(secret, target)
    except OSError:
        pass
    try:
        os.unlink(target)
    except OSError:
        pass
    try:
        fd = os.open(target, os.O_CREAT | os.O_WRONLY | os.O_TRUNC, 0o644)
        os.write(fd, b"public\\n")
        os.close(fd)
    except OSError:
        pass
`;
    const dirSwap = `
import os, sys
nested, secret_dir, backup = sys.argv[1], sys.argv[2], sys.argv[3]
while True:
    try:
        if os.path.isdir(nested) and not os.path.islink(nested):
            os.rename(nested, backup)
    except OSError:
        pass
    try:
        if not os.path.lexists(nested):
            os.symlink(secret_dir, nested)
    except OSError:
        pass
    try:
        if os.path.islink(nested):
            os.unlink(nested)
    except OSError:
        pass
    try:
        if os.path.isdir(backup) and not os.path.lexists(nested):
            os.rename(backup, nested)
    except OSError:
        pass
`;
    const renameSwap = `
import os, sys
target, secret = sys.argv[1], sys.argv[2]
link = target + ".swaplink"
tmp = target + ".swapfile"
while True:
    try:
        if not os.path.lexists(link):
            os.symlink(secret, link)
        os.rename(link, target)
    except OSError:
        pass
    try:
        fd = os.open(tmp, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o644)
        os.write(fd, b"public\\n")
        os.close(fd)
        os.rename(tmp, target)
    except OSError:
        try:
            os.unlink(tmp)
        except OSError:
            pass
`;

    async function runRace(label, prepare, source, argBuilder) {
      const parent = fs.mkdtempSync(path.join(os.homedir(), "fb-race-"));
      const root = path.join(parent, "tree");
      const secretFile = path.join(parent, "secret.txt");
      const secretDir = path.join(parent, "secret-dir");
      fs.writeFileSync(secretFile, `${SECRET}\n`);
      fs.mkdirSync(secretDir);
      fs.writeFileSync(path.join(secretDir, "note.txt"), `${SECRET}\n`);
      fs.mkdirSync(root);
      const script = path.join(parent, "racer.py");
      fs.writeFileSync(script, source);
      prepare(root);
      const child = spawn("python3", [script, ...argBuilder(root, secretFile, secretDir)], {
        cwd: os.homedir(),
        detached: true,
        stdio: "ignore",
      });
      await new Promise((resolve) => setTimeout(resolve, 40));
      let passed = 0;
      let refused = 0;
      try {
        for (let index = 0; index < ITERATIONS; index += 1) {
          const result = inspectAgentTree(root);
          assert.equal(leaked(result), false, `${label} iteration ${index}`);
          if (!result.ok) refused += 1;
          passed += 1;
        }
      } finally {
        killChild(child);
        fs.rmSync(parent, { recursive: true, force: true });
      }
      assert.ok(refused > 0, `${label} never observed the swap`);
      t.diagnostic(`${label} race iterations passed: ${passed}/${ITERATIONS} (${refused} refused)`);
      return passed;
    }

    const filePassed = await runRace(
      "file-swap",
      (root) => {
        const folder = path.join(root, "apps", "feedback-board");
        fs.mkdirSync(folder, { recursive: true });
        fs.writeFileSync(path.join(folder, "keep.txt"), "public\n");
      },
      fileSwap,
      (root, secretFile) => [path.join(root, "apps", "feedback-board", "keep.txt"), secretFile],
    );
    const dirPassed = await runRace(
      "dir-swap",
      (root) => {
        const nested = path.join(root, "apps", "feedback-board", "nested");
        fs.mkdirSync(nested, { recursive: true });
        fs.writeFileSync(path.join(nested, "note.txt"), "public\n");
      },
      dirSwap,
      (root, _secretFile, secretDir) => [
        path.join(root, "apps", "feedback-board", "nested"),
        secretDir,
        path.join(root, "apps", "feedback-board", "nested.real"),
      ],
    );
    const renamePassed = await runRace(
      "same-dir-rename",
      (root) => {
        const folder = path.join(root, "apps", "feedback-board");
        fs.mkdirSync(folder, { recursive: true });
        fs.writeFileSync(path.join(folder, "keep.txt"), "public\n");
      },
      renameSwap,
      (root, secretFile) => [path.join(root, "apps", "feedback-board", "keep.txt"), secretFile],
    );
    const total = filePassed + dirPassed + renamePassed;
    t.diagnostic(`race iterations passed: ${total}/${ITERATIONS * 3}, secret leaked: 0`);
    assert.equal(total, ITERATIONS * 3);
  });

  it("refuses a hardlink, a backslash, a newline, a fifo, and a case-variant metadata name", () => {
    const root = fs.mkdtempSync(path.join(os.homedir(), "fb-meta-"));
    const folder = path.join(root, "apps", "feedback-board");
    const secret = path.join(root, "secret.txt");
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(secret, `${SECRET}\n`);
    try {
      fs.linkSync(secret, path.join(folder, "linked.txt"));
      const hard = inspectAgentTree(root);
      assert.equal(hard.ok, false);
      assert.match(hard.reason, /hardlink/);
      assert.equal(leaked(hard), false);
      fs.rmSync(path.join(folder, "linked.txt"));

      fs.writeFileSync(path.join(folder, "a\\b.txt"), "x\n");
      assert.match(inspectAgentTree(root).reason, /unsafe path/);
      fs.rmSync(path.join(folder, "a\\b.txt"));

      fs.writeFileSync(path.join(folder, "a\nb.txt"), "x\n");
      assert.match(inspectAgentTree(root).reason, /unsafe path/);
      fs.rmSync(path.join(folder, "a\nb.txt"));

      fs.mkdirSync(path.join(folder, ".GIT"));
      assert.match(inspectAgentTree(root).reason, /\.git/);
      fs.rmSync(path.join(folder, ".GIT"), { recursive: true, force: true });

      fs.writeFileSync(path.join(folder, "keep.txt"), "public\n");
      const started = Date.now();
      spawnSync("mkfifo", [path.join(folder, "pipe")]);
      const fifo = inspectAgentTree(root);
      assert.match(fifo.reason, /fifo/);
      assert.ok(Date.now() - started < 2000);
      assert.equal(leaked(fifo), false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not follow a symlink while writing the fresh tree", () => {
    const root = fs.mkdtempSync(path.join(os.homedir(), "fb-write-"));
    const outside = fs.mkdtempSync(path.join(os.homedir(), "fb-outside-"));
    const secret = path.join(outside, "secret.txt");
    fs.writeFileSync(secret, `${SECRET}\n`);
    fs.mkdirSync(path.join(root, "apps", "feedback-board"), { recursive: true });
    fs.symlinkSync(outside, path.join(root, "apps", "feedback-board", "sub"));
    try {
      assert.throws(() =>
        applyTreeChanges(root, [
          { path: "apps/feedback-board/sub/x.txt", kind: "add", bytes: Buffer.from("nope\n") },
        ]),
      );
      assert.equal(fs.readFileSync(secret, "utf8").includes(SECRET), true);
      assert.equal(fs.readFileSync(secret, "utf8").includes("nope"), false);
      fs.unlinkSync(path.join(root, "apps", "feedback-board", "sub"));
      const target = path.join(root, "apps", "feedback-board", "keep.txt");
      fs.symlinkSync(secret, target);
      assert.throws(() =>
        applyTreeChanges(root, [{ path: "apps/feedback-board/keep.txt", kind: "modify", bytes: Buffer.from("nope\n") }]),
      );
      assert.equal(fs.readFileSync(secret, "utf8").includes("nope"), false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("refuses to publish while a setsid child is still writing", async () => {
    const parent = fs.mkdtempSync(path.join(os.homedir(), "fb-live-"));
    const repo = path.join(parent, "repo");
    const agent = path.join(parent, "agent");
    const stateRoot = path.join(parent, "state");
    fs.mkdirSync(path.join(repo, "apps", "feedback-board"), { recursive: true });
    fs.writeFileSync(path.join(repo, "README.md"), "readme\n");
    fs.writeFileSync(path.join(repo, "apps", "feedback-board", "keep.txt"), "base\n");
    await git(repo, ["init", "-b", "main"]);
    await git(repo, ["add", "."]);
    await git(repo, ["commit", "-m", "init"]);
    const baseSha = (await git(repo, ["rev-parse", "HEAD"])).trim();
    await git(repo, ["worktree", "add", "-b", BRANCH, agent, baseSha]);
    await mutateState((state) => {
      state.cards.push({
        id: CARD_ID,
        column: "in_progress",
        locked: true,
        runStatus: "running",
        message: null,
        outOfScopePaths: [],
      });
    }, stateRoot);
    const writer = spawn(
      "python3",
      ["-c", "import os, time\ntry:\n    os.setsid()\nexcept OSError:\n    pass\nwhile True:\n    open('apps/feedback-board/keep.txt','a').write('x')\n    time.sleep(0.05)\n"],
      { cwd: agent, detached: true, stdio: "ignore" },
    );
    await new Promise((resolve) => setTimeout(resolve, 150));
    try {
      const outcome = await publishAgentTree({
        cardId: CARD_ID,
        workCopy: repo,
        agentWorktree: agent,
        branch: BRANCH,
        baseSha,
        push: false,
        openPullRequest: false,
        stateRoot,
      });
      assert.equal(outcome.rejected, true);
      assert.match(outcome.reason, /process is still using/);
      const state = await readState(stateRoot);
      assert.equal(state.cards[0].runStatus, "out_of_scope");
      const tip = (await git(repo, ["rev-parse", BRANCH])).trim();
      assert.equal(tip, baseSha);
    } finally {
      killChild(writer);
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });

  it("kills a setsid grandchild when the contained agent exits", { skip: process.platform !== "linux" }, async () => {
    const marker = path.join(os.homedir(), `fb-contained-${process.pid}`);
    fs.rmSync(marker, { force: true });
    const plan = agentSpawnPlan("bash", ["-c", `setsid bash -c 'sleep 8; echo alive > ${marker}' >/dev/null 2>&1 & exit 0`]);
    assert.equal(plan.contained, true);
    assert.equal(plan.args.includes("--pid"), true);
    assert.equal(plan.args.includes("--fork"), true);
    assert.equal(plan.args.includes("--kill-child"), true);
    const child = spawn(plan.command, plan.args, { detached: true, stdio: "ignore" });
    const code = await new Promise((resolve) => child.once("close", resolve));
    assert.equal(code, 0);
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(fs.existsSync(marker), false);
    const listing = execFileSync("ps", ["-eo", "args"], { encoding: "utf8" });
    assert.equal(listing.includes(marker), false);
  });

  it("does not follow a symlink while removing an agent tree", () => {
    const parent = fs.mkdtempSync(path.join(os.homedir(), "fb-rm-"));
    const tree = path.join(parent, "tree");
    const outside = path.join(parent, "outside");
    fs.mkdirSync(path.join(tree, "apps", "feedback-board", "nested"), { recursive: true });
    fs.mkdirSync(outside);
    const secret = path.join(outside, "secret.txt");
    fs.writeFileSync(secret, `${SECRET}\n`);
    fs.writeFileSync(path.join(tree, "apps", "feedback-board", "nested", "note.txt"), "public\n");
    fs.rmSync(path.join(tree, "apps", "feedback-board", "nested"), { recursive: true, force: true });
    fs.symlinkSync(outside, path.join(tree, "apps", "feedback-board", "nested"));
    try {
      const removed = removeAgentTree(tree);
      assert.equal(removed.ok, true);
      assert.equal(fs.existsSync(tree), false);
      assert.equal(fs.readFileSync(secret, "utf8"), `${SECRET}\n`);
    } finally {
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });

  it("refuses a file moved in from outside the recorded tree", () => {
    const parent = fs.mkdtempSync(path.join(os.homedir(), "fb-moved-"));
    const root = path.join(parent, "tree");
    const folder = path.join(root, "apps", "feedback-board");
    fs.mkdirSync(folder, { recursive: true });
    const keep = path.join(folder, "keep.txt");
    fs.writeFileSync(keep, "public\n");
    const snap = snapshotAgentTree(root);
    assert.equal(snap.ok, true);
    const later = Date.now() / 1000 + 30;
    fs.writeFileSync(keep, "edited\n");
    const edited = inspectAgentTree(root, { inodes: snap.inodes, spawnTime: later, base: {} });
    assert.equal(edited.ok, true);
    assert.equal(edited.allowed.get("apps/feedback-board/keep.txt").toString(), "edited\n");
    const secret = path.join(parent, "auth.json");
    fs.writeFileSync(secret, `${SECRET}\n`);
    const notes = path.join(folder, "notes.txt");
    fs.renameSync(secret, notes);
    try {
      const moved = inspectAgentTree(root, { inodes: snap.inodes, spawnTime: later, base: {} });
      assert.equal(moved.ok, false);
      assert.match(moved.reason, /moved in/);
      assert.equal(leaked(moved), false);
      fs.unlinkSync(notes);
      fs.writeFileSync(path.join(folder, "fresh.txt"), "agent\n");
      const created = inspectAgentTree(root, { inodes: snap.inodes, spawnTime: Date.now() / 1000 - 1, base: {} });
      assert.equal(created.ok, true);
      assert.equal(created.allowed.get("apps/feedback-board/fresh.txt").toString(), "agent\n");
      assert.equal(created.allowed.get("apps/feedback-board/keep.txt").toString(), "edited\n");
    } finally {
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });

  it("treats an lsof timeout, a short read, and an empty failure as busy", () => {
    const root = path.join(os.homedir(), "fb-lsof-root");
    const boom = (error) => () => {
      throw error;
    };
    assert.equal(lsofUsers(root, boom(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }))).ok, false);
    assert.equal(lsofUsers(root, boom(Object.assign(new Error("buf"), { code: "ENOBUFS" }))).ok, false);
    assert.equal(
      lsofUsers(root, boom(Object.assign(new Error("trunc"), { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", stdout: "p1\n" }))).ok,
      false,
    );
    assert.equal(lsofUsers(root, boom(Object.assign(new Error("empty"), { status: 1, stdout: "" }))).ok, false);
    const quiet = () => "";
    assert.equal(lsofUsers(root, quiet).ok, true);
    const hit = () => `p42\nn${root}/apps/feedback-board/keep.txt\n`;
    const busy = lsofUsers(root, hit);
    assert.equal(busy.ok, false);
    assert.deepEqual(busy.blocked, ["42"]);
    const parsed = interpretLsofOutput(`p7\nn${root}\n`, root);
    assert.equal(parsed.ok, false);
    assert.equal(LSOF_BIN, "/usr/sbin/lsof");
  });

  it("re-reads the marker and does not kill a reused pid", () => {
    const marker = "feedbac0";
    const killed = [];
    const events = [];
    const result = killMarkedProcesses(marker, "darwin", {
      execFileSync: (_bin, args) => {
        if (args.includes("lstart=")) {
          events.push("lstart");
          return "Fri Oct  9 22:00:00 2026\n";
        }
        events.push(args[0] === "-p" ? "reread" : "scan");
        if (args[0] === "-p") return "  4242 launchd\n";
        return `  4242 sleep ${RUN_MARKER_ENV}=${marker}\n`;
      },
      kill: (pid) => killed.push(pid),
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.killed, []);
    assert.deepEqual(killed, []);
    assert.deepEqual(events, ["scan", "lstart", "reread"]);
  });

  it("kills a pid only after a re-read still shows the marker", () => {
    const marker = "feedbac1";
    const killed = [];
    const events = [];
    const result = killMarkedProcesses(marker, "darwin", {
      execFileSync: (_bin, args) => {
        if (args.includes("lstart=")) {
          events.push(`lstart:${args[1]}`);
          return "Fri Oct  9 22:00:00 2026\n";
        }
        events.push(args[0] === "-p" ? `reread:${args[1]}` : "scan");
        if (args[0] === "-p") {
          if (args[1] === "5150") return `  5150 python ${RUN_MARKER_ENV}=${marker}\n`;
          return "  6161 launchd\n";
        }
        return `  5150 python ${RUN_MARKER_ENV}=${marker}\n  6161 python ${RUN_MARKER_ENV}=${marker}\n`;
      },
      kill: (pid, signal) => {
        events.push(`kill:${pid}:${signal}`);
        killed.push(pid);
      },
    });
    assert.equal(result.ok, true);
    assert.deepEqual(killed, [5150]);
    assert.deepEqual(events, ["scan", "lstart:5150", "reread:5150", "lstart:5150", "kill:5150:SIGKILL", "lstart:6161", "reread:6161"]);
  });

  it("does not kill when the process start time changed", () => {
    const marker = "feedbac5";
    const killed = [];
    let stamps = 0;
    const result = killMarkedProcesses(marker, "darwin", {
      execFileSync: (_bin, args) => {
        if (args.includes("lstart=")) {
          stamps += 1;
          return stamps === 1 ? "Fri Oct  9 22:00:00 2026\n" : "Fri Oct  9 22:00:05 2026\n";
        }
        return `  4242 python ${RUN_MARKER_ENV}=${marker}\n`;
      },
      kill: (pid) => killed.push(pid),
    });
    assert.equal(result.ok, true);
    assert.deepEqual(killed, []);
    assert.deepEqual(result.killed, []);
  });

  it("does not kill when the marker re-read fails", () => {
    const marker = "feedbac2";
    const killed = [];
    const result = killMarkedProcesses(marker, "darwin", {
      execFileSync: (_bin, args) => {
        if (args[0] === "-p") throw Object.assign(new Error("ps failed"), { status: 2 });
        return `  7171 python ${RUN_MARKER_ENV}=${marker}\n`;
      },
      kill: (pid) => killed.push(pid),
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, AGENT_BUSY);
    assert.deepEqual(killed, []);
  });

  it("treats a missing darwin marker as busy and does not scan", () => {
    let scanned = false;
    const result = killMarkedProcesses("", "darwin", {
      execFileSync: () => {
        scanned = true;
        return "";
      },
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, AGENT_BUSY);
    assert.equal(scanned, false);
    assert.equal(killMarkedProcesses(undefined, "linux").ok, true);
  });

  it("counts an open file reported through a symlink as using the tree", () => {
    const parent = fs.mkdtempSync(path.join(os.homedir(), "fb-lsof-alias-"));
    const real = path.join(parent, "real");
    const alias = path.join(parent, "alias");
    fs.mkdirSync(real);
    fs.symlinkSync(real, alias);
    const file = path.join(real, "keep.txt");
    fs.writeFileSync(file, "x");
    try {
      const busy = interpretLsofOutput(`p9\nn${file}\n`, alias);
      assert.equal(busy.ok, false);
      assert.deepEqual(busy.blocked, ["9"]);
      const outside = path.join(parent, "outside");
      fs.mkdirSync(outside);
      assert.equal(interpretLsofOutput(`p9\nn${file}\n`, outside).ok, true);
    } finally {
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });

  it("treats a failed marker scan as busy and does not kill", () => {
    const killed = [];
    const result = killMarkedProcesses("feedbac4", "darwin", {
      execFileSync: () => {
        throw Object.assign(new Error("ps failed"), { status: 1 });
      },
      kill: (pid) => killed.push(pid),
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, AGENT_BUSY);
    assert.deepEqual(killed, []);
  });

  it("skips a pid that is already gone at the marker re-read", () => {
    const marker = "feedbac3";
    const killed = [];
    const result = killMarkedProcesses(marker, "darwin", {
      execFileSync: (_bin, args) => {
        if (args[0] === "-p") throw Object.assign(new Error("no such process"), { status: 1 });
        return `  8181 python ${RUN_MARKER_ENV}=${marker}\n`;
      },
      kill: (pid) => killed.push(pid),
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.killed, []);
    assert.deepEqual(killed, []);
  });

  it("finds processes by the run marker and kills them on darwin", { skip: process.platform !== "darwin" }, async () => {
    const marker = `m${process.pid.toString(16)}`;
    const listing = `    1 launchd\n   77 ${RUN_MARKER_ENV}=other\n  ${process.pid} ${RUN_MARKER_ENV}=${marker}\n  4242 python ${RUN_MARKER_ENV}=${marker}\n`;
    assert.deepEqual(pidsCarryingMarker(listing, marker), [4242]);
    const child = spawn(
      "python3",
      ["-c", "import os, time\nos.setsid()\nos.chdir('/')\nfd=os.open('/dev/null', os.O_RDWR)\nos.dup2(fd, 0)\nos.dup2(fd, 1)\nos.dup2(fd, 2)\ntime.sleep(30)\n"],
      { env: { [RUN_MARKER_ENV]: marker, PATH: process.env.PATH }, detached: true, stdio: "ignore" },
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    try {
      const killed = killMarkedProcesses(marker);
      assert.equal(killed.ok, true);
      await new Promise((resolve) => setTimeout(resolve, 200));
      let alive = true;
      try {
        process.kill(child.pid, 0);
      } catch (error) {
        alive = error.code !== "ESRCH";
      }
      assert.equal(alive, false);
    } finally {
      try {
        process.kill(child.pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
  });

  it("scans open files with lsof on darwin", { skip: process.platform !== "darwin" }, async () => {
    const dir = fs.mkdtempSync(path.join(os.homedir(), "fb-lsof-"));
    const child = spawn("sleep", ["30"], { cwd: dir, detached: true, stdio: "ignore" });
    await new Promise((resolve) => setTimeout(resolve, 200));
    try {
      const idle = lsofUsers(os.homedir());
      assert.equal(typeof idle.ok, "boolean");
      const busy = lsofUsers(dir);
      assert.equal(busy.ok, false);
    } finally {
      try {
        process.kill(child.pid, "SIGKILL");
      } catch {
        // Already gone.
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("copies only grok auth into a private home", () => {
    const real = fs.mkdtempSync(path.join(os.homedir(), "fb-auth-"));
    const grok = path.join(real, ".grok");
    fs.mkdirSync(grok);
    fs.writeFileSync(path.join(grok, "auth.json"), "token-value\n", { mode: 0o600 });
    fs.writeFileSync(path.join(grok, "mcp_credentials.json"), "mcp-secret\n");
    fs.symlinkSync(path.join(grok, "auth.json"), path.join(grok, "linked.json"));
    try {
      const sandbox = prepareAgentSandbox(real);
      const copied = path.join(sandbox.grokHome, "auth.json");
      assert.equal(sandbox.authCopied, true);
      assert.equal(sandbox.authBytes.toString("utf8"), "token-value\n");
      assert.equal(fs.readFileSync(copied, "utf8"), "token-value\n");
      assert.equal(fs.statSync(copied).mode & 0o777, 0o444);
      assert.equal(fs.existsSync(path.join(sandbox.grokHome, "mcp_credentials.json")), false);
      assert.equal(copyGrokAuth(path.join(grok, "linked.json"), path.join(sandbox.grokHome, "nope.json")), false);
      const env = scrubAgentEnv(
        { HOME: real, GROK_HOME: grok, TMPDIR: os.tmpdir(), PATH: "/usr/bin" },
        { home: sandbox.home, tmp: sandbox.tmp, marker: "abc" },
      );
      assert.equal(env.HOME, sandbox.home);
      assert.equal(env.GROK_HOME, sandbox.grokHome);
      assert.equal(env.TMPDIR, sandbox.tmp);
      assert.equal(env[RUN_MARKER_ENV], "abc");
      assert.equal(env.HOME.includes(`${path.sep}.grok`), false);
      const stripped = scrubAgentEnv(
        { XAI_API_KEY: "present", PATH: "/usr/bin" },
        { home: sandbox.home, tmp: sandbox.tmp },
      );
      assert.equal(Object.hasOwn(stripped, "XAI_API_KEY"), false);
      assert.equal(stripped.PATH, "/usr/bin");
      assert.equal(Object.hasOwn(stripped, "TMP"), false);
      assert.equal(Object.hasOwn(stripped, "GH_CONFIG_DIR"), false);
      removeAgentTree(sandbox.root);
    } finally {
      fs.rmSync(real, { recursive: true, force: true });
    }
  });
});
