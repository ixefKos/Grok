import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { promisify } from "node:util";
import { describe, it } from "node:test";
import { observeProcesses } from "../server/exec.js";
import { mutateState, readState } from "../server/store.js";
import { freshWorktreePath, inspectAgentTree } from "../server/tree-gate.js";
import { publishAgentTree } from "../server/runs.js";

const execFileAsync = promisify(execFile);
const CARD_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
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

function isInside(root, value) {
  if (!value) return false;
  const base = path.resolve(root);
  const target = path.resolve(String(value));
  return target === base || target.startsWith(`${base}${path.sep}`);
}

function assertGitStaysOut(calls, agentWorktree) {
  const gitCalls = calls.filter((call) => call.command === "git");
  assert.ok(gitCalls.length > 0);
  for (const call of gitCalls) {
    assert.equal(isInside(agentWorktree, call.cwd), false, `cwd ${call.cwd}`);
    assert.equal(isInside(agentWorktree, call.env && call.env.GIT_WORK_TREE), false, call.env && call.env.GIT_WORK_TREE);
  }
}

async function git(cwd, args) {
  const { stdout } = await execFileAsync("git", args, { cwd, env: gitEnv });
  return stdout;
}

async function setupRepo() {
  const parent = fs.mkdtempSync(path.join("/home/ubuntu", "fb-tree-"));
  const repo = path.join(parent, "repo");
  const agent = path.join(parent, "agent");
  const stateRoot = path.join(parent, "state");
  fs.mkdirSync(path.join(repo, "apps", "feedback-board"), { recursive: true });
  fs.mkdirSync(path.join(repo, "apps", "thedailylumen"), { recursive: true });
  fs.writeFileSync(path.join(repo, "README.md"), "readme\n");
  fs.writeFileSync(path.join(repo, "apps", "feedback-board", "keep.txt"), "base\n");
  fs.writeFileSync(path.join(repo, "apps", "feedback-board", "gone.txt"), "gone\n");
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
  return { parent, repo, agent, stateRoot, baseSha };
}

describe("agent tree publish", { concurrency: 1 }, () => {
  it("refuses a symlink, a socket, and a .gitattributes file", async () => {
    const root = fs.mkdtempSync(path.join("/home/ubuntu", "fb-tree-inspect-"));
    const folder = path.join(root, "apps", "feedback-board");
    fs.mkdirSync(folder, { recursive: true });
    try {
      fs.symlinkSync("keep.txt", path.join(folder, "link"));
      const link = inspectAgentTree(root);
      assert.equal(link.ok, false);
      assert.match(link.reason, /symlink/);
      fs.unlinkSync(path.join(folder, "link"));

      const socketPath = path.join(folder, "sock");
      const server = net.createServer();
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(socketPath, resolve);
      });
      try {
        const socket = inspectAgentTree(root);
        assert.equal(socket.ok, false);
        assert.match(socket.reason, /socket/);
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }
      fs.rmSync(socketPath, { force: true });

      fs.writeFileSync(path.join(folder, ".gitattributes"), "*.txt filter=pwn\n");
      const attributes = inspectAgentTree(root);
      assert.equal(attributes.ok, false);
      assert.match(attributes.reason, /gitattributes/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("turns the card red for a nested repo filter and never runs the canary", async () => {
    const fixture = await setupRepo();
    const canary = path.join(fixture.parent, "PWNED");
    const calls = [];
    const stop = observeProcesses((event) => calls.push(event));
    try {
      const nested = path.join(fixture.agent, "apps", "feedback-board", "x");
      fs.mkdirSync(path.join(nested, ".git"), { recursive: true });
      fs.writeFileSync(
        path.join(nested, ".git", "config"),
        `[filter "pwn"]\n\tclean = touch ${canary}\n`,
      );
      fs.writeFileSync(path.join(fixture.agent, "apps", "feedback-board", ".gitattributes"), "*.txt filter=pwn\n");
      fs.writeFileSync(path.join(fixture.agent, "apps", "feedback-board", "keep.txt"), "pwned\n");
      const outcome = await publishAgentTree({
        cardId: CARD_ID,
        workCopy: fixture.repo,
        agentWorktree: fixture.agent,
        branch: BRANCH,
        baseSha: fixture.baseSha,
        push: false,
        openPullRequest: false,
        stateRoot: fixture.stateRoot,
      });
      assert.equal(outcome.rejected, true);
      assert.match(outcome.reason, /\.git/);
      assert.doesNotMatch(outcome.reason, /gitattributes/);
      assert.equal(fs.existsSync(canary), false);
      const state = await readState(fixture.stateRoot);
      assert.equal(state.cards[0].runStatus, "out_of_scope");
      for (const call of calls) {
        if (call.command !== "git") continue;
        assert.equal(isInside(fixture.agent, call.cwd), false, `cwd ${call.cwd}`);
        assert.equal(isInside(fixture.agent, call.env && call.env.GIT_WORK_TREE), false);
      }
      const tip = (await git(fixture.repo, ["rev-parse", BRANCH])).trim();
      assert.equal(tip, fixture.baseSha);
    } finally {
      stop();
      fs.rmSync(fixture.parent, { recursive: true, force: true });
    }
  });

  it("commits an in-scope edit and a deletion in a fresh worktree, never git in the agent tree", async () => {
    const fixture = await setupRepo();
    const calls = [];
    const stop = observeProcesses((event) => calls.push(event));
    const fresh = freshWorktreePath(fixture.repo, CARD_ID);
    try {
      fs.writeFileSync(path.join(fixture.agent, "apps", "feedback-board", "keep.txt"), "edited\n");
      fs.rmSync(path.join(fixture.agent, "apps", "feedback-board", "gone.txt"));
      const outcome = await publishAgentTree({
        cardId: CARD_ID,
        workCopy: fixture.repo,
        agentWorktree: fixture.agent,
        branch: BRANCH,
        baseSha: fixture.baseSha,
        push: false,
        openPullRequest: false,
        stateRoot: fixture.stateRoot,
      });
      assert.equal(outcome.ok, true);
      assert.match(outcome.sha, /^[0-9a-f]{40}$/);
      assert.notEqual(outcome.sha, fixture.baseSha);
      assert.equal(await git(fixture.repo, ["show", `${outcome.sha}:apps/feedback-board/keep.txt`]), "edited\n");
      await assert.rejects(() => git(fixture.repo, ["cat-file", "-e", `${outcome.sha}:apps/feedback-board/gone.txt`]));
      const subject = (await git(fixture.repo, ["log", "-1", "--format=%s", outcome.sha])).trim();
      assert.equal(subject, "feedback: card bbbbbbbb");
      const names = await git(fixture.repo, ["diff-tree", "--no-commit-id", "--name-status", "-r", fixture.baseSha, outcome.sha]);
      assert.match(names, /M\tapps\/feedback-board\/keep\.txt/);
      assert.match(names, /D\tapps\/feedback-board\/gone\.txt/);
      assert.equal(fs.existsSync(fresh), false);
      assert.equal(fs.existsSync(fixture.agent), false);
      assertGitStaysOut(calls, fixture.agent);
      assert.ok(calls.some((call) => call.command === "git" && call.env.GIT_WORK_TREE === path.resolve(fresh)));
      assert.ok(calls.every((call) => call.command !== "git" || !isInside(fixture.agent, call.cwd)));
    } finally {
      stop();
      fs.rmSync(fixture.parent, { recursive: true, force: true });
    }
  });
});
