import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { agentSpawnPlan } from "../server/agent-launch.js";
import { mutateState, readState } from "../server/store.js";
import { applyTreeChanges, inspectAgentTree } from "../server/tree-gate.js";
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
      const parent = fs.mkdtempSync(path.join("/home/ubuntu", "fb-race-"));
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
        cwd: "/home/ubuntu",
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
    const root = fs.mkdtempSync(path.join("/home/ubuntu", "fb-meta-"));
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
    const root = fs.mkdtempSync(path.join("/home/ubuntu", "fb-write-"));
    const outside = fs.mkdtempSync(path.join("/home/ubuntu", "fb-outside-"));
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
    const parent = fs.mkdtempSync(path.join("/home/ubuntu", "fb-live-"));
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
      "setsid",
      ["bash", "-c", "while true; do printf x >> apps/feedback-board/keep.txt; sleep 0.05; done"],
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

  it("kills a setsid grandchild when the contained agent exits", async () => {
    const marker = path.join("/home/ubuntu", `fb-contained-${process.pid}`);
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
});
