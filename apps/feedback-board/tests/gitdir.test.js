import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, it } from "node:test";
import { boardGitEnv, pushArgs, PUSH_URL } from "../server/agent-launch.js";
import {
  assertWorktreeGitFile,
  BOARD_GIT_CONFIG_ARGS,
  cleanupVerdict,
  failedSpawnCleanupArgs,
  findRegisteredGitDir,
  porcelainListsWorktree,
  postRunGitPlan,
  runIfPinned,
  withBoardGitArgs,
} from "../server/git-pin.js";

const execFileAsync = promisify(execFile);
const CARD_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const BRANCH = `feedback/card-${CARD_ID}`;
const SHA = "a".repeat(40);

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "Feedback Board Test",
  GIT_AUTHOR_EMAIL: "feedback-board-test@example.com",
  GIT_COMMITTER_NAME: "Feedback Board Test",
  GIT_COMMITTER_EMAIL: "feedback-board-test@example.com",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
};

async function git(cwd, args) {
  const { stdout } = await execFileAsync("git", args, { cwd, env: gitEnv });
  return stdout;
}

async function setupWorktree() {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "feedback-gitdir-"));
  const repo = path.join(parent, "repo");
  const worktree = path.join(parent, "wt");
  fs.mkdirSync(repo);
  await git(repo, ["init", "-b", "main"]);
  await git(repo, ["commit", "--allow-empty", "-m", "init"]);
  await git(repo, ["worktree", "add", "-b", BRANCH, worktree, "HEAD"]);
  const common = (await git(repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim();
  const porcelain = await git(repo, ["worktree", "list", "--porcelain"]);
  assert.equal(porcelainListsWorktree(porcelain, worktree), true);
  const gitDir = findRegisteredGitDir(common, worktree);
  assert.equal(typeof gitDir, "string");
  assert.deepEqual(assertWorktreeGitFile(worktree, gitDir), { ok: true });
  return { parent, repo, worktree, gitDir, common };
}

describe("pinned worktree git dir", () => {
  it("refuses a rewritten gitdir and does not run the canary fsmonitor", async () => {
    const { parent, repo, worktree, gitDir } = await setupWorktree();
    const canary = path.join(parent, "PWNED");
    const fake = path.join(parent, "fake.git");
    fs.mkdirSync(path.join(fake, "objects", "info"), { recursive: true });
    fs.mkdirSync(path.join(fake, "refs"));
    fs.writeFileSync(path.join(fake, "HEAD"), "ref: refs/heads/main\n");
    fs.writeFileSync(path.join(fake, "config"), `[core]\n\tfsmonitor = touch ${canary}\n`);
    fs.writeFileSync(path.join(fake, "objects", "info", "alternates"), `${path.join(repo, ".git", "objects")}\n`);
    fs.writeFileSync(path.join(worktree, ".git"), `gitdir: ${fake}\n`);

    const plan = postRunGitPlan({
      worktreePath: worktree,
      gitDir,
      args: ["diff", "--name-only"],
      env: boardGitEnv(),
    });
    assert.equal(plan.ok, false);
    assert.equal(plan.ran, false);
    assert.equal(plan.args, null);
    assert.match(plan.reason, /rewritten/);
    let ran = false;
    const outcome = await runIfPinned(plan, async () => {
      ran = true;
      return { code: 0, stdout: "", stderr: "" };
    });
    assert.equal(outcome.ran, false);
    assert.equal(ran, false);
    assert.equal(fs.existsSync(canary), false);

    await execFileAsync("git", ["diff", "--name-only"], { cwd: worktree, env: gitEnv });
    assert.equal(fs.existsSync(canary), true);
  });

  it("refuses a symlinked .git file", async () => {
    const { parent, worktree, gitDir } = await setupWorktree();
    const canary = path.join(parent, "PWNED");
    const linked = path.join(parent, "linked-git");
    fs.writeFileSync(linked, `gitdir: ${gitDir}\n`);
    fs.rmSync(path.join(worktree, ".git"));
    fs.symlinkSync(linked, path.join(worktree, ".git"));
    const plan = postRunGitPlan({
      worktreePath: worktree,
      gitDir,
      args: ["status"],
      env: boardGitEnv(),
    });
    assert.equal(plan.ok, false);
    assert.match(plan.reason, /regular file/);
    const outcome = await runIfPinned(plan, async () => ({ code: 0, stdout: "", stderr: "" }));
    assert.equal(outcome.ran, false);
    assert.equal(fs.existsSync(canary), false);
  });

  it("pins post-run git to the recorded dir and the safety config", async () => {
    const { worktree, gitDir } = await setupWorktree();
    const plan = postRunGitPlan({
      worktreePath: worktree,
      gitDir,
      args: pushArgs(SHA, BRANCH),
      env: boardGitEnv(),
    });
    assert.equal(plan.ok, true);
    assert.equal(plan.env.GIT_DIR, gitDir);
    assert.equal(plan.env.GIT_WORK_TREE, path.resolve(worktree));
    assert.equal(plan.env.GIT_CONFIG_GLOBAL, "/dev/null");
    assert.equal(plan.env.GIT_CONFIG_NOSYSTEM, "1");
    for (const flag of [
      "core.fsmonitor=false",
      "http.sslVerify=true",
      "http.proxy=",
      "core.sshCommand=",
      "core.hooksPath=/dev/null",
      "diff.ignoreSubmodules=all",
      "status.submoduleSummary=false",
      "submodule.recurse=false",
    ]) {
      assert.equal(plan.args.includes(flag), true, flag);
    }
    assert.equal(plan.args.includes(PUSH_URL), true);
    assert.deepEqual(withBoardGitArgs(["rev-parse", "HEAD"]).slice(0, BOARD_GIT_CONFIG_ARGS.length), BOARD_GIT_CONFIG_ARGS);
    const headPlan = postRunGitPlan({
      worktreePath: worktree,
      gitDir,
      args: ["rev-parse", "HEAD"],
      env: boardGitEnv(),
    });
    const head = await execFileAsync("git", headPlan.args, {
      cwd: worktree,
      env: { ...gitEnv, ...headPlan.env },
    });
    assert.match(head.stdout, /^[0-9a-f]{40}\n$/);
  });

  it("removes the worktree and branch so the same card can be added again", async () => {
    const { repo, worktree, common } = await setupWorktree();
    const cleanup = failedSpawnCleanupArgs(worktree, BRANCH);
    await git(repo, withBoardGitArgs(cleanup.remove));
    await git(repo, withBoardGitArgs(cleanup.branch));
    await git(repo, withBoardGitArgs(["worktree", "add", "-b", BRANCH, worktree, "HEAD"]));
    const gitDir = findRegisteredGitDir(common, worktree);
    assert.equal(assertWorktreeGitFile(worktree, gitDir).ok, true);
  });

  it("fails cleanup when worktree remove or branch delete exits non-zero", () => {
    const cleanup = failedSpawnCleanupArgs("/worktree", BRANCH);
    assert.deepEqual(cleanup.prune, ["worktree", "prune"]);
    assert.deepEqual(cleanupVerdict([{ code: 0 }, { code: 0 }, { code: 0 }]), { ok: true });
    const failed = cleanupVerdict([{ code: 0 }, { code: 1, signal: null }, { code: 0 }]);
    assert.equal(failed.ok, false);
    assert.equal(failed.reason, "Could not clean up the worktree.");
    assert.equal(cleanupVerdict([{ code: 0 }, { code: null, signal: "SIGKILL" }]).ok, false);
  });
});
