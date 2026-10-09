import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, it } from "node:test";
import {
  boardGitEnv,
  commitArgs,
  GH_CREDENTIAL_HELPER,
  pullRequestText,
  pushArgs,
  PUSH_URL,
} from "../server/agent-launch.js";
import { assessLocalConfig, evaluateRemoteGuard, LOCAL_CONFIG_PATTERN } from "../server/guard.js";
import { applyReservation, rollbackReservation } from "../server/runs.js";
import { mutateState, readState } from "../server/store.js";

const execFileAsync = promisify(execFile);
const GOOD = "https://github.com/ixefKos/Grok.git";
const CARD_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const BRANCH = `feedback/card-${CARD_ID}`;
const SHA = "a".repeat(40);

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "Feedback Board Test",
  GIT_AUTHOR_EMAIL: "feedback-board-test@example.com",
  GIT_COMMITTER_NAME: "Feedback Board Test",
  GIT_COMMITTER_EMAIL: "feedback-board-test@example.com",
  GIT_CONFIG_NOSYSTEM: "1",
};

async function gitResult(cwd, args, env = gitEnv) {
  try {
    const { stdout, stderr } = await execFileAsync("git", args, { cwd, env });
    return { code: 0, stdout, stderr: stderr || "" };
  } catch (error) {
    return { code: error.code, stdout: error.stdout || "", stderr: error.stderr || "" };
  }
}

describe("local config pattern", () => {
  it("matches includeif in either case", () => {
    const matcher = new RegExp(LOCAL_CONFIG_PATTERN);
    assert.match("includeif.gitdir:/tmp/x.path /tmp/x", matcher);
    assert.match("includeIf.gitdir:/tmp/x.path /tmp/x", matcher);
    assert.match("includeIF.gitdir:/tmp/x.path /tmp/x", matcher);
    assert.match("url.https://evil.example/.insteadof https://github.com/", matcher);
    assert.equal(matcher.test("user.name Ada"), false);
  });
});

describe("remote guard", () => {
  it("accepts fetch and push URLs that are all ixefKos/Grok", () => {
    assert.deepEqual(
      evaluateRemoteGuard({
        fetchUrls: `${GOOD}\n`,
        pushUrls: `${GOOD}\n`,
      }),
      { ok: true },
    );
  });

  it("rejects a second push URL", () => {
    const extraPush = evaluateRemoteGuard({
      fetchUrls: GOOD,
      pushUrls: `${GOOD}\nhttps://github.com/evil/other.git\n`,
    });
    assert.equal(extraPush.ok, false);
    assert.match(extraPush.reason, /ixefKos\/Grok/);
  });

  it("does not block on a global insteadOf key", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "feedback-global-url-"));
    const globalFile = path.join(cwd, "fake-global.gitconfig");
    fs.writeFileSync(
      globalFile,
      '[url "https://example.invalid/"]\n\tinsteadOf = https://github.com/\n',
    );
    await execFileAsync("git", ["init", "-b", "main"], { cwd, env: gitEnv });
    await execFileAsync("git", ["remote", "add", "origin", GOOD], { cwd, env: gitEnv });
    const env = { ...gitEnv, GIT_CONFIG_GLOBAL: globalFile };
    const unscoped = await gitResult(cwd, ["config", "--get-regexp", LOCAL_CONFIG_PATTERN], env);
    assert.equal(unscoped.code, 0);
    assert.match(unscoped.stdout, /url\.https:\/\/example\.invalid\/\.insteadof/);
    const local = await gitResult(cwd, ["config", "--local", "--get-regexp", LOCAL_CONFIG_PATTERN], env);
    const worktree = await gitResult(
      cwd,
      ["config", "--worktree", "--get-regexp", LOCAL_CONFIG_PATTERN],
      env,
    );
    assert.equal(local.code, 1);
    assert.equal(worktree.code, 1);
    assert.equal(local.stdout, "");
    assert.equal(worktree.stdout, "");
    assert.deepEqual(assessLocalConfig([local, worktree]), { ok: true });
  });

  it("blocks a local url.* key and a local include.* key", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "feedback-local-url-"));
    const env = { ...gitEnv, GIT_CONFIG_GLOBAL: "/dev/null" };
    await execFileAsync("git", ["init", "-b", "main"], { cwd, env });
    await execFileAsync("git", ["remote", "add", "origin", GOOD], { cwd, env });
    await execFileAsync(
      "git",
      ["config", "--local", "url.https://evil.example/.insteadOf", "https://github.com/"],
      { cwd, env },
    );
    const urlHit = await gitResult(cwd, ["config", "--local", "--get-regexp", LOCAL_CONFIG_PATTERN], env);
    assert.match(urlHit.stdout, /^url\.https:\/\/evil\.example\/\.insteadof https:\/\/github\.com\/$/m);
    const blockedUrl = assessLocalConfig([urlHit, { code: 1, stdout: "" }]);
    assert.equal(blockedUrl.ok, false);
    assert.match(blockedUrl.reason, /url\.\*/);

    const includeRepo = fs.mkdtempSync(path.join(os.tmpdir(), "feedback-local-include-"));
    await execFileAsync("git", ["init", "-b", "main"], { cwd: includeRepo, env });
    const includeFile = path.join(includeRepo, "extra.gitconfig");
    fs.writeFileSync(includeFile, "[user]\n\tname = Local Include\n");
    await execFileAsync("git", ["config", "--local", "include.path", includeFile], {
      cwd: includeRepo,
      env,
    });
    const includeHit = await gitResult(
      includeRepo,
      ["config", "--local", "--get-regexp", LOCAL_CONFIG_PATTERN],
      env,
    );
    assert.match(includeHit.stdout, /^include\.path /m);
    const blockedInclude = assessLocalConfig([includeHit, { code: 1, stdout: "" }]);
    assert.equal(blockedInclude.ok, false);
    assert.match(blockedInclude.reason, /include\.\*/);
  });

  it("ignores a global includeIf that points into the worktree when the board env is set", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "feedback-includeif-"));
    await execFileAsync("git", ["init", "-b", "main"], { cwd, env: gitEnv });
    const evil = path.join(cwd, "evil.inc");
    fs.writeFileSync(evil, "[user]\n\tname = EVIL\n");
    const globalFile = path.join(cwd, "fake-global.gitconfig");
    fs.writeFileSync(globalFile, `[includeIf "gitdir:${cwd}/"]\n\tpath = ${evil}\n`);
    const exposed = { ...gitEnv, GIT_CONFIG_GLOBAL: globalFile };
    const seen = await gitResult(cwd, ["config", "--show-origin", "--get", "user.name"], exposed);
    assert.equal(seen.code, 0);
    assert.match(seen.stdout, /EVIL/);
    assert.match(seen.stdout, /evil\.inc/);
    const isolated = await gitResult(cwd, ["config", "--get", "user.name"], boardGitEnv(exposed));
    assert.equal(isolated.code, 1);
    assert.equal(isolated.stdout.includes("EVIL"), false);
    assert.equal(boardGitEnv(exposed).GIT_CONFIG_GLOBAL, "/dev/null");
    assert.equal(boardGitEnv(exposed).GIT_CONFIG_NOSYSTEM, "1");
  });

  it("treats a disabled worktree config as no hit and still blocks a worktree url key", async () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "feedback-wt-"));
    const cwd = path.join(parent, "repo");
    const worktree = path.join(parent, "wt");
    fs.mkdirSync(cwd);
    const env = { ...gitEnv, GIT_CONFIG_GLOBAL: "/dev/null" };
    await execFileAsync("git", ["init", "-b", "main"], { cwd, env });
    await execFileAsync("git", ["commit", "--allow-empty", "-m", "init"], { cwd, env });
    await execFileAsync("git", ["worktree", "add", "-b", BRANCH, worktree, "HEAD"], { cwd, env });
    const unavailable = await gitResult(
      worktree,
      ["config", "--worktree", "--get-regexp", LOCAL_CONFIG_PATTERN],
      env,
    );
    assert.equal(unavailable.code, 128);
    assert.equal(unavailable.stdout, "");
    assert.match(unavailable.stderr, /multiple working trees/);
    assert.deepEqual(assessLocalConfig([unavailable]), { ok: true });
    assert.equal(assessLocalConfig([{ code: 128, stdout: "", stderr: "fatal: other" }]).ok, false);
    assert.equal(assessLocalConfig([{ code: null, signal: "SIGKILL", stdout: "" }]).ok, false);
    assert.equal(assessLocalConfig([{ code: null, signal: null, stdout: "" }]).ok, false);
    assert.equal(assessLocalConfig([{ code: 1, signal: "SIGTERM", stdout: "" }]).ok, false);
    assert.match(assessLocalConfig([{ code: null, signal: "SIGKILL", stdout: "" }]).reason, /Could not read git url config/);

    await execFileAsync("git", ["config", "extensions.worktreeConfig", "true"], { cwd, env });
    await execFileAsync(
      "git",
      ["config", "--worktree", "url.https://evil.example/.insteadOf", "https://github.com/"],
      { cwd: worktree, env },
    );
    const hit = await gitResult(
      worktree,
      ["config", "--worktree", "--get-regexp", LOCAL_CONFIG_PATTERN],
      env,
    );
    assert.match(hit.stdout, /url\.https:\/\/evil\.example\/\.insteadof/);
    const blocked = assessLocalConfig([{ code: 1, stdout: "" }, hit]);
    assert.equal(blocked.ok, false);
    assert.match(blocked.reason, /url\.\*/);
  });
});

describe("publish text and push args", () => {
  it("pushes a pinned sha with gh credentials and global config disabled", () => {
    const args = pushArgs(SHA, BRANCH);
    assert.deepEqual(args, [
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "credential.helper=",
      "-c",
      `credential.https://github.com.helper=${GH_CREDENTIAL_HELPER}`,
      "push",
      PUSH_URL,
      `${SHA}:refs/heads/${BRANCH}`,
    ]);
    assert.equal(GH_CREDENTIAL_HELPER, "!gh auth git-credential");
    assert.equal(args.includes("origin"), false);
    assert.equal(args.some((part) => part.includes("'")), false);
    assert.deepEqual(boardGitEnv(), {
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
    });
    assert.deepEqual(commitArgs("feedback: card aaaaaaaa"), [
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "credential.helper=",
      "-c",
      `credential.https://github.com.helper=${GH_CREDENTIAL_HELPER}`,
      "-c",
      "user.name=feedback-board",
      "-c",
      "user.email=feedback-board@localhost",
      "commit",
      "-m",
      "feedback: card aaaaaaaa",
    ]);
    assert.deepEqual(
      commitArgs("feedback: card aaaaaaaa", { name: "Local Name", email: "local@example.com" }).slice(6, 10),
      ["-c", "user.name=Local Name", "-c", "user.email=local@example.com"],
    );
  });

  it("keeps the card title and notes out of the pull request text", () => {
    const secretTitle = "Synthetic private title zeta";
    const secretNotes = "Synthetic private notes eta";
    const text = pullRequestText(CARD_ID, ["apps/feedback-board/README.md"]);
    assert.equal(text.title, "feedback: card aaaaaaaa");
    assert.equal(text.message, "feedback: card aaaaaaaa");
    assert.equal(text.body.includes(secretTitle), false);
    assert.equal(text.body.includes(secretNotes), false);
    assert.match(text.body, /apps\/feedback-board\/README.md/);
    assert.match(text.body, /Changed files:/);
    assert.match(text.body, /not merged/);
    assert.equal(text.title.includes(secretTitle), false);
  });
});

describe("run wiring", () => {
  it("pins baseSha, locks, and pushes through the guarded helpers", () => {
    const source = fs.readFileSync(new URL("../server/runs.js", import.meta.url), "utf8");
    const pinAt = source.indexOf('["rev-parse", "origin/main"]');
    const reserveAt = source.indexOf("const reserved = await reserveRun");
    const spawnAt = source.indexOf("spawnGrok(");
    assert.ok(pinAt > 0 && reserveAt > pinAt && spawnAt > reserveAt);
    assert.ok(source.indexOf("fresh.locked = true") > 0);
    assert.equal(source.includes("origin/main...HEAD"), false);
    assert.equal(source.includes("origin/main.."), false);
    assert.equal(source.includes('["push", "-u", "origin"'), false);
    assert.equal(source.includes("gateDiffArgs("), true);
    assert.equal(source.includes("pushArgs("), true);
    assert.equal(source.includes("commitArgs("), true);
    assert.equal(source.includes("scrubAgentEnv("), true);
    assert.equal(source.includes("killProcessGroup("), true);
    assert.equal(source.includes("pullRequestText("), true);
    assert.equal(source.includes("readOriginGuard("), true);
    assert.equal(source.includes('"--local"'), true);
    assert.equal(source.includes('"--worktree"'), true);
    assert.equal(source.includes('["config", "--get-regexp"'), false);
    assert.match(
      source,
      /pinnedOk\(cardId, pushArgs\(finalSha, branch\), pin, 120000, "git push failed\.", boardGitEnv\(\)\)/,
    );
    assert.match(source, /commitArgs\(text\.message, identity\)/);
    assert.match(source, /postRunGitPlan\(/);
    const pinned = source.slice(source.indexOf("async function pinnedGit"));
    assert.ok(pinned.indexOf("postRunGitPlan(") < pinned.indexOf('logged(cardId, "git"'));
    const spawnFail = source.indexOf("if (!spawned)");
    const cleanup = source.indexOf("cleanupFailedWorktree(", spawnFail);
    const rollback = source.indexOf("rollbackReservedRun(", cleanup);
    assert.ok(spawnFail > 0 && cleanup > spawnFail && rollback > cleanup);
  });
});

describe("reservation rollback", () => {
  it("unlocks the card and decrements the daily count when spawn does not happen", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "feedback-rollback-"));
    const today = "2026-10-09";
    await mutateState((state) => {
      state.cards.push({
        id: CARD_ID,
        column: "todo",
        locked: false,
        runStatus: null,
        message: "earlier note",
        outOfScopePaths: [],
      });
      state.usage = { date: today, count: 1 };
    }, root);
    const reserved = await mutateState(
      (state) => applyReservation(state, CARD_ID, { dailyCap: 3, today }),
      root,
    );
    assert.equal(reserved.ok, true);
    assert.equal(reserved.state.cards[0].locked, true);
    assert.equal(reserved.state.cards[0].column, "in_progress");
    assert.equal(reserved.state.cards[0].runStatus, "running");
    assert.equal(reserved.state.usage.count, 2);
    await mutateState(
      (state) => rollbackReservation(state, CARD_ID, reserved.previous, reserved.today),
      root,
    );
    const after = await readState(root);
    assert.equal(after.cards[0].locked, false);
    assert.equal(after.cards[0].column, "todo");
    assert.equal(after.cards[0].runStatus, null);
    assert.equal(after.cards[0].message, "earlier note");
    assert.equal(after.usage.count, 1);
    assert.equal(after.usage.date, today);
  });
});
