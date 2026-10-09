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
import { CREDENTIAL_RUN_STATUS, scanPublishChanges } from "../server/credential-scan.js";
import { publishAgentTree, rememberAgentBaseline } from "../server/runs.js";

const execFileAsync = promisify(execFile);
const CARD_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const BRANCH = `feedback/card-${CARD_ID}`;
const TOKEN = "provisioned-auth-" + "token-value";
const AUTH = Buffer.from(`${JSON.stringify({ access_token: TOKEN })}\n`);
const NOTE = "apps/feedback-board/note.txt";
const API_URL = "https://api.x.ai/v1/models";

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "Feedback Board Test",
  GIT_AUTHOR_EMAIL: "feedback-board-test@example.com",
  GIT_COMMITTER_NAME: "Feedback Board Test",
  GIT_COMMITTER_EMAIL: "feedback-board-test@example.com",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
};

function repeat(prefix, count, char) {
  return prefix + char.repeat(count);
}

function header(middle) {
  return "-----BEGIN " + middle;
}

const SAMPLES = [
  ["xai-", () => repeat("xai-", 20, "A")],
  ["ghp_", () => repeat("ghp_", 36, "a")],
  ["gho_", () => repeat("gho_", 36, "b")],
  ["ghs_", () => repeat("ghs_", 36, "c")],
  ["github_pat_", () => repeat("github_pat_", 22, "d")],
  ["sk-", () => repeat("sk-", 20, "e")],
  ["AKIA", () => repeat("AKIA", 16, "F")],
  ["private-key", () => header("PRIVATE KEY-----")],
];

function hides(value, secret) {
  const buf = Buffer.isBuffer(value) ? value : Buffer.from(String(value ?? ""));
  assert.equal(buf.includes(Buffer.from(secret)), false);
}

function hidesAll(value, secrets) {
  for (const secret of secrets) hides(value, secret);
}

function assertHit(result, pattern, index, secrets) {
  assert.equal(result.ok, false);
  assert.equal(result.runStatus, CREDENTIAL_RUN_STATUS);
  assert.equal(result.pattern, pattern);
  assert.equal(result.index, index);
  assert.match(result.reason, new RegExp(`${pattern.replaceAll("_", "\\_")} at file ${index}`));
  hidesAll(result.reason, secrets);
  hidesAll(JSON.stringify(result.hits), secrets);
  hidesAll(JSON.stringify(result.blocked), secrets);
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
      const text = sample();
      const result = scanPublishChanges([{ path: NOTE, kind: "add", bytes: Buffer.from(text) }], AUTH);
      assertHit(result, name, 0, [text, TOKEN]);
    });
  }

  it("matches a bare private-key header and a typed header", () => {
    for (const middle of ["PRIVATE KEY-----", "RSA PRIVATE KEY-----", "OPENSSH PRIVATE KEY-----", "RSA PRIVATE KEY BLOCK-----"]) {
      const text = header(middle);
      const result = scanPublishChanges([{ path: NOTE, kind: "add", bytes: Buffer.from(text) }], null);
      assertHit(result, "private-key", 0, [text]);
    }
  });

  it("scans two megabytes of near-header text quickly", () => {
    const bytes = Buffer.from("-----BEGIN " + "A".repeat(2 * 1024 * 1024));
    const started = process.hrtime.bigint();
    const result = scanPublishChanges([{ path: NOTE, kind: "add", bytes }], null);
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    assert.equal(result.ok, true);
    assert.ok(elapsedMs < 1000, `elapsed ${elapsedMs}`);
  });

  it("matches a base64 auth token without returning it", () => {
    const planted = Buffer.from(TOKEN).toString("base64");
    const result = scanPublishChanges([{ path: NOTE, kind: "add", bytes: Buffer.from(planted) }], AUTH);
    assertHit(result, "auth-token", 0, [TOKEN, planted]);
  });

  it("matches base64 of the token plus a newline", () => {
    const planted = Buffer.from(`${TOKEN}\n`).toString("base64");
    const result = scanPublishChanges([{ path: NOTE, kind: "add", bytes: Buffer.from(planted) }], AUTH);
    assertHit(result, "auth-token", 0, [TOKEN, planted]);
  });

  it("matches base64 of a JSON line holding the token", () => {
    const line = `${JSON.stringify({ access_token: TOKEN })}\n`;
    const planted = Buffer.from(line).toString("base64");
    const result = scanPublishChanges([{ path: NOTE, kind: "add", bytes: Buffer.from(planted) }], AUTH);
    assertHit(result, "auth-token", 0, [TOKEN, planted, line]);
  });

  for (const align of [1, 2]) {
    it(`matches base64 when the token starts at offset ${align}`, () => {
      const prefix = Buffer.alloc(align, 0xab);
      const suffix = Buffer.from([0xcd]);
      const planted = Buffer.concat([prefix, Buffer.from(TOKEN), suffix]).toString("base64");
      const result = scanPublishChanges([{ path: NOTE, kind: "add", bytes: Buffer.from(planted) }], AUTH);
      assertHit(result, "auth-token", 0, [TOKEN, planted]);
    });
  }

  it("matches the url-safe base64 form", () => {
    const planted = Buffer.from(TOKEN).toString("base64url");
    const result = scanPublishChanges([{ path: NOTE, kind: "add", bytes: Buffer.from(planted) }], AUTH);
    assertHit(result, "auth-token", 0, [TOKEN, planted]);
  });

  it("matches the raw auth token without returning it", () => {
    const result = scanPublishChanges([{ path: NOTE, kind: "add", bytes: Buffer.from(TOKEN) }], AUTH);
    assertHit(result, "auth-token", 0, [TOKEN]);
  });

  it("leaves ordinary words and an auth url alone", () => {
    const words = ["task-list", "desk-", "mask-image", "risk-", "disk-", "xai-org", "TAKIAN", API_URL].join("\n");
    const auth = Buffer.from(`${JSON.stringify({ base_url: API_URL, access_token: TOKEN })}\n`);
    const result = scanPublishChanges([{ path: NOTE, kind: "add", bytes: Buffer.from(`${words}\n`) }], auth);
    assert.equal(result.ok, true);
    assert.deepEqual(result.blocked, []);
  });

  it("does not treat a short secret-key value as a needle", () => {
    const short = "short-token-value";
    const auth = Buffer.from(JSON.stringify({ access_token: short }));
    const result = scanPublishChanges([{ path: NOTE, kind: "add", bytes: Buffer.from(short) }], auth);
    assert.equal(result.ok, true);
  });

  it("does not refuse its own source", () => {
    const scanner = fs.readFileSync(new URL("../server/credential-scan.js", import.meta.url));
    const test = fs.readFileSync(new URL("./credential-scan.test.js", import.meta.url));
    assert.equal(scanPublishChanges([{ path: NOTE, kind: "add", bytes: scanner }], AUTH).ok, true);
    assert.equal(scanPublishChanges([{ path: NOTE, kind: "add", bytes: test }], AUTH).ok, true);
  });

  it("reports a credential path by index", () => {
    const text = repeat("xai-", 20, "A");
    const result = scanPublishChanges(
      [{ path: `apps/feedback-board/${text}.txt`, kind: "add", bytes: Buffer.from("public note\n") }],
      AUTH,
    );
    assertHit(result, "xai-", 0, [text]);
    hides(result.reason, "feedback-board");
  });
});

describe("credential publish", { concurrency: 1 }, () => {
  for (const [name, sample] of SAMPLES) {
    it(`refuses a publish containing the ${name} pattern before commit`, async () => {
      const text = sample();
      await assertRefused(Buffer.from(text), name, [text, TOKEN]);
    });
  }

  it("refuses a publish containing the raw auth token before commit", async () => {
    await assertRefused(Buffer.from(TOKEN), "auth-token", [TOKEN]);
  });

  it("refuses a publish containing a base64 auth token before commit", async () => {
    const planted = Buffer.from(TOKEN).toString("base64");
    await assertRefused(Buffer.from(planted), "auth-token", [TOKEN, planted]);
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

async function assertRefused(bytes, pattern, secrets) {
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
    assert.equal(outcome.runStatus, CREDENTIAL_RUN_STATUS);
    assert.equal(outcome.pattern, pattern);
    assert.equal(outcome.index, 0);
    const state = await readState(fixture.stateRoot);
    const card = state.cards[0];
    assert.equal(card.runStatus, CREDENTIAL_RUN_STATUS);
    const log = fs.readFileSync(path.join(fixture.stateRoot, "data", "runs", `${CARD_ID}.log`));
    const surfaced = [outcome.reason, card.message, JSON.stringify(card.outOfScopePaths), log];
    for (const value of surfaced) hidesAll(value, secrets);
    assert.match(card.message, new RegExp(`${pattern.replaceAll("_", "\\_")} at file 0`));
    assert.equal(calls.some((call) => call.command === "git" && call.args.includes("commit")), false);
    const tip = (await git(fixture.repo, ["rev-parse", BRANCH])).trim();
    assert.equal(tip, fixture.baseSha);
  } finally {
    stop();
    fs.rmSync(fixture.parent, { recursive: true, force: true });
  }
}
