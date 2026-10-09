import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, it } from "node:test";
import { assertHeadOnBranch, findOutOfScopePaths, gateDiffArgs, listChangedPaths } from "../server/guard.js";

const execFileAsync = promisify(execFile);
const CARD_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const BRANCH = `feedback/card-${CARD_ID}`;

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "Feedback Board Test",
  GIT_AUTHOR_EMAIL: "feedback-board-test@example.com",
  GIT_COMMITTER_NAME: "Feedback Board Test",
  GIT_COMMITTER_EMAIL: "feedback-board-test@example.com",
};

async function git(cwd, args) {
  const { stdout } = await execFileAsync("git", args, { cwd, env: gitEnv });
  return stdout;
}

async function initRepo() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "feedback-gate-"));
  await git(cwd, ["init", "-b", "main"]);
  return cwd;
}

describe("changed-files gate bypasses", () => {
  it("lists the source path of a rename when --no-renames is set", async () => {
    const cwd = await initRepo();
    fs.writeFileSync(path.join(cwd, "README.md"), "synthetic\n");
    await git(cwd, ["add", "README.md"]);
    await git(cwd, ["commit", "-m", "add readme"]);
    const baseSha = (await git(cwd, ["rev-parse", "HEAD"])).trim();
    fs.mkdirSync(path.join(cwd, "apps", "feedback-board"), { recursive: true });
    await git(cwd, ["mv", "README.md", "apps/feedback-board/x.md"]);

    const cachedPlain = (await git(cwd, ["diff", "--name-only", "--cached"])).trim();
    const cachedFixed = (await git(cwd, ["diff", "--name-only", "--cached", "--no-renames"])).trim();
    assert.equal(cachedPlain, "apps/feedback-board/x.md");
    assert.match(cachedFixed, /^README\.md$/m);
    assert.match(cachedFixed, /^apps\/feedback-board\/x\.md$/m);

    await git(cwd, ["commit", "-m", "move readme"]);
    const plainRange = (await git(cwd, ["diff", "--name-only", `${baseSha}..HEAD`])).trim();
    const fixed = (await git(cwd, gateDiffArgs(baseSha, "HEAD"), { cwd, env: gitEnv })).trim();
    assert.equal(plainRange, "apps/feedback-board/x.md");
    assert.match(fixed, /^README\.md$/m);
    assert.deepEqual(findOutOfScopePaths(listChangedPaths(fixed)), ["README.md"]);
    assert.equal(gateDiffArgs(baseSha).includes("--no-renames"), true);
    assert.equal(gateDiffArgs(baseSha).join(" ").includes("origin/main"), false);
  });

  it("keeps a pinned baseSha when origin/main moves", async () => {
    const cwd = await initRepo();
    fs.mkdirSync(path.join(cwd, "apps", "feedback-board"), { recursive: true });
    fs.writeFileSync(path.join(cwd, "apps", "feedback-board", "ok.txt"), "ok\n");
    await git(cwd, ["add", "apps/feedback-board/ok.txt"]);
    await git(cwd, ["commit", "-m", "in scope"]);
    const baseSha = (await git(cwd, ["rev-parse", "HEAD"])).trim();
    await git(cwd, ["update-ref", "refs/remotes/origin/main", baseSha]);
    await git(cwd, ["checkout", "-b", BRANCH]);
    fs.writeFileSync(path.join(cwd, "README.md"), "out\n");
    await git(cwd, ["add", "README.md"]);
    await git(cwd, ["commit", "-m", "out of scope"]);
    const head = (await git(cwd, ["rev-parse", "HEAD"])).trim();
    await git(cwd, ["update-ref", "refs/remotes/origin/main", head]);

    const mutable = (await git(cwd, ["diff", "--name-only", "--no-renames", "origin/main..HEAD"])).trim();
    const pinned = (await git(cwd, gateDiffArgs(baseSha, head))).trim();
    assert.equal(mutable, "");
    assert.equal(pinned, "README.md");
    assert.deepEqual(findOutOfScopePaths(listChangedPaths(pinned)), ["README.md"]);
    assert.equal(gateDiffArgs(baseSha).at(-1), `${baseSha}..HEAD`);
  });

  it("requires HEAD to be refs/heads/feedback/card-<id>", async () => {
    const cwd = await initRepo();
    fs.writeFileSync(path.join(cwd, "README.md"), "synthetic\n");
    await git(cwd, ["add", "README.md"]);
    await git(cwd, ["commit", "-m", "first"]);
    await git(cwd, ["checkout", "-b", BRANCH]);
    fs.writeFileSync(path.join(cwd, "README.md"), "second\n");
    await git(cwd, ["add", "README.md"]);
    await git(cwd, ["commit", "-m", "second"]);
    const headSha = (await git(cwd, ["rev-parse", "HEAD"])).trim();
    const branchSha = (await git(cwd, ["rev-parse", `refs/heads/${BRANCH}`])).trim();
    const symbolicHead = (await git(cwd, ["symbolic-ref", "--quiet", "HEAD"])).trim();
    assert.deepEqual(assertHeadOnBranch({ headSha, branchSha, branch: BRANCH, symbolicHead }), { ok: true });

    await git(cwd, ["checkout", "--detach", "HEAD"]);
    let detachedSymbolic = "";
    try {
      detachedSymbolic = (await git(cwd, ["symbolic-ref", "--quiet", "HEAD"])).trim();
    } catch {
      detachedSymbolic = "";
    }
    const detachedHead = (await git(cwd, ["rev-parse", "HEAD"])).trim();
    const detached = assertHeadOnBranch({
      headSha: detachedHead,
      branchSha,
      branch: BRANCH,
      symbolicHead: detachedSymbolic,
    });
    assert.equal(detached.ok, false);
    assert.match(detached.reason, /card branch/);

    await git(cwd, ["checkout", "main"]);
    const otherHead = (await git(cwd, ["rev-parse", "HEAD"])).trim();
    const otherSymbolic = (await git(cwd, ["symbolic-ref", "--quiet", "HEAD"])).trim();
    const other = assertHeadOnBranch({
      headSha: otherHead,
      branchSha,
      branch: BRANCH,
      symbolicHead: otherSymbolic,
    });
    assert.equal(other.ok, false);
  });
});
