import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, it } from "node:test";
import { observeProcesses } from "../server/exec.js";
import { mutateState, readState } from "../server/store.js";
import { snapshotAgentTree } from "../server/tree-gate.js";
import { CREDENTIAL_REASON, scanPublishChanges } from "../server/credential-scan.js";
import { publishAgentTree, rememberAgentBaseline } from "../server/runs.js";

const execFileAsync = promisify(execFile);
const CARD_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const BRANCH = `feedback/card-${CARD_ID}`;
const TOKEN = "provisioned-auth-token-value";
const AUTH = Buffer.from(`${JSON.stringify({ access_token: TOKEN })}\n`);
const NOTE = "apps/feedback-board/note.txt";

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "Feedback Board Test",
  GIT_AUTHOR_EMAIL: "feedback-board-test@example.com",
  GIT_COMMITTER_NAME: "Feedback Board Test",
  GIT_COMMITTER_EMAIL: "feedback-board-test@example.com",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
};

const SAMPLES = [
  ["xai-", "xai-FBTEST"],
  ["ghp_", "ghp_FBTEST"],
  ["gho_", "gho_FBTEST"],
  ["ghs_", "ghs_FBTEST"],
  ["github_pat_", "github_pat_FBTEST"],
  ["sk-", "sk-FBTEST"],
  ["AKIA", "AKIAFBTEST"],
  ["private key header", "-----BEGIN RSA PRIVATE KEY-----\nFBTESTKEY\n-----END RSA PRIVATE KEY-----\n"],
];

function hides(value, secret) {
  const buf = Buffer.isBuffer(value) ? value : Buffer.from(String(value ?? ""));
  assert.equal(buf.includes(Buffer.from(secret)), false);
}

function hidesAll(value, secrets) {
  for (const secret of secrets) hides(value, secret);
}

async function git(cwd, args) {
  const { stdout } = await execFileAsync("git", args, { cwd, env: gitEnv });
  return stdout;
}

async function setupRepo() {
  const parent = fs.mkdtempSync(path.join(os.homedir(), "fb-cred-"));
  const repo = path.join(parent, "repo");
  const agent = path.join(parent, "agent");
  const stateRoot = path.join(parent, "state");
  fs.mkdirSync(path.join(repo, "apps", "feedback-board"), { recursive: true });
  fs.mkdirSync(path.join(repo, "apps", "thedailylumen"), { recursive: true });
  fs.writeFileSync(path.join(repo, "README.md"), "readme\n");
  fs.writeFileSync(path.join(repo, "apps", "feedback-board", "keep.txt"), "base\n");
  await git(repo, ["init", "-b", "main"]);
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-m", "init"]);
  const baseSha = (await git(repo, ["rev-parse", "HEAD"])).trim();
  await git(repo, ["worktree", "add", "-b", BRANCH, agent, baseSha]);
  const snap = snapshotAgentTree(agent);
  if (!snap.ok) throw new Error(snap.reason);
  rememberAgentBaseline(CARD_ID, { inodes: snap.inodes, spawnTime: 0, authBytes: AUTH });
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

describe("credential scan", () => {
  for (const [name, sample] of SAMPLES) {
    it(`matches the ${name} pattern without returning the value`, () => {
      const result = scanPublishChanges([{ path: NOTE, kind: "add", bytes: Buffer.from(sample) }], AUTH);
      assert.equal(result.ok, false);
      assert.equal(result.reason, CREDENTIAL_REASON);
      assert.deepEqual(result.blocked, [NOTE]);
      hidesAll(result.reason, [sample, TOKEN]);
      hidesAll(JSON.stringify(result.blocked), [sample, TOKEN]);
    });
  }

  it("matches a base64 auth token without returning it", () => {
    const planted = Buffer.from(TOKEN).toString("base64");
    const result = scanPublishChanges([{ path: NOTE, kind: "add", bytes: Buffer.from(planted) }], AUTH);
    assert.equal(result.ok, false);
    assert.equal(result.reason, CREDENTIAL_REASON);
    hidesAll(result.reason, [TOKEN, planted]);
    hidesAll(JSON.stringify(result), [TOKEN, planted]);
  });

  it("matches the raw auth token without returning it", () => {
    const result = scanPublishChanges([{ path: NOTE, kind: "add", bytes: Buffer.from(TOKEN) }], AUTH);
    assert.equal(result.ok, false);
    assert.equal(result.reason, CREDENTIAL_REASON);
    hides(result.reason, TOKEN);
    hides(JSON.stringify(result.blocked), TOKEN);
  });

  it("leaves a clean file alone", () => {
    const result = scanPublishChanges([{ path: NOTE, kind: "add", bytes: Buffer.from("public note\n") }], AUTH);
    assert.equal(result.ok, true);
    assert.deepEqual(result.blocked, []);
  });

  it("omits a path that itself contains a credential", () => {
    const sample = "xai-FBTEST";
    const result = scanPublishChanges(
      [{ path: `apps/feedback-board/${sample}.txt`, kind: "add", bytes: Buffer.from("public note\n") }],
      AUTH,
    );
    assert.equal(result.ok, false);
    assert.equal(result.reason, CREDENTIAL_REASON);
    assert.deepEqual(result.blocked, []);
    hides(JSON.stringify(result), sample);
  });
});

describe("credential publish", { concurrency: 1 }, () => {
  for (const [name, sample] of SAMPLES) {
    it(`refuses a publish containing the ${name} pattern before commit`, async () => {
      await assertRefused(Buffer.from(sample), [sample, TOKEN]);
    });
  }

  it("refuses a publish containing the raw auth token before commit", async () => {
    await assertRefused(Buffer.from(TOKEN), [TOKEN]);
  });

  it("refuses a publish containing a base64 auth token before commit", async () => {
    const planted = Buffer.from(TOKEN).toString("base64");
    await assertRefused(Buffer.from(planted), [TOKEN, planted]);
  });

  it("publishes a new file that has no credential", async () => {
    const fixture = await setupRepo();
    try {
      fs.writeFileSync(path.join(fixture.agent, "apps", "feedback-board", "note.txt"), "public note\n");
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
      assert.notEqual(outcome.sha, fixture.baseSha);
      assert.equal(await git(fixture.repo, ["show", `${outcome.sha}:${NOTE}`]), "public note\n");
      const log = fs.readFileSync(path.join(fixture.stateRoot, "data", "runs", `${CARD_ID}.log`));
      hides(log, TOKEN);
    } finally {
      fs.rmSync(fixture.parent, { recursive: true, force: true });
    }
  });
});

async function assertRefused(bytes, secrets) {
  const fixture = await setupRepo();
  const calls = [];
  const stop = observeProcesses((event) => calls.push(event));
  try {
    fs.writeFileSync(path.join(fixture.agent, "apps", "feedback-board", "note.txt"), bytes);
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
    assert.equal(outcome.reason, CREDENTIAL_REASON);
    const state = await readState(fixture.stateRoot);
    const card = state.cards[0];
    assert.equal(card.runStatus, "out_of_scope");
    const log = fs.readFileSync(path.join(fixture.stateRoot, "data", "runs", `${CARD_ID}.log`));
    const surfaced = [outcome.reason, card.message, JSON.stringify(card.outOfScopePaths), JSON.stringify(outcome.blocked), log];
    for (const value of surfaced) hidesAll(value, secrets);
    assert.equal(calls.some((call) => call.command === "git" && call.args.includes("commit")), false);
    const tip = (await git(fixture.repo, ["rev-parse", BRANCH])).trim();
    assert.equal(tip, fixture.baseSha);
  } finally {
    stop();
    fs.rmSync(fixture.parent, { recursive: true, force: true });
  }
}
