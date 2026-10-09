import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, it } from "node:test";
import { commitArgs, pullRequestText, pushArgs, PUSH_URL } from "../server/agent-launch.js";
import { evaluateRemoteGuard } from "../server/guard.js";

const execFileAsync = promisify(execFile);
const GOOD = "https://github.com/ixefKos/Grok.git";
const CARD_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const BRANCH = `feedback/card-${CARD_ID}`;
const SHA = "a".repeat(40);

describe("remote guard", () => {
  it("accepts fetch and push URLs that are all ixefKos/Grok and no url.* keys", () => {
    assert.deepEqual(
      evaluateRemoteGuard({
        fetchUrls: `${GOOD}\n`,
        pushUrls: `${GOOD}\n`,
        urlConfigText: "",
      }),
      { ok: true },
    );
  });

  it("rejects a second push URL and any url.* config key", () => {
    const extraPush = evaluateRemoteGuard({
      fetchUrls: GOOD,
      pushUrls: `${GOOD}\nhttps://github.com/evil/other.git\n`,
      urlConfigText: "",
    });
    assert.equal(extraPush.ok, false);
    assert.match(extraPush.reason, /ixefKos\/Grok/);

    const insteadOf = evaluateRemoteGuard({
      fetchUrls: GOOD,
      pushUrls: GOOD,
      urlConfigText: "url.https://evil.example/.insteadof https://github.com/\n",
    });
    assert.equal(insteadOf.ok, false);
    assert.match(insteadOf.reason, /url\.\*/);
  });

  it("reads a local url.* key in the git config format", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "feedback-remote-"));
    await execFileAsync("git", ["init", "-b", "main"], { cwd });
    await execFileAsync("git", ["remote", "add", "origin", GOOD], { cwd });
    await execFileAsync(
      "git",
      ["config", "--local", "url.https://evil.example/.insteadOf", "https://github.com/"],
      { cwd },
    );
    const { stdout } = await execFileAsync("git", ["config", "--local", "--get-regexp", "^url\\."], { cwd });
    assert.match(stdout, /^url\.https:\/\/evil\.example\/\.insteadof https:\/\/github\.com\/$/m);
    const fetchUrls = (await execFileAsync("git", ["remote", "get-url", "--all", "origin"], { cwd })).stdout;
    const pushUrls = (await execFileAsync("git", ["remote", "get-url", "--push", "--all", "origin"], { cwd })).stdout;
    assert.equal(
      evaluateRemoteGuard({ fetchUrls, pushUrls, urlConfigText: stdout }).ok,
      false,
    );
    assert.equal(evaluateRemoteGuard({ fetchUrls, pushUrls, urlConfigText: "" }).ok, true);
  });
});

describe("publish text and push args", () => {
  it("pushes a pinned sha to the explicit Grok URL with hooks disabled", () => {
    const args = pushArgs(SHA, BRANCH);
    assert.deepEqual(args, [
      "-c",
      "core.hooksPath=/dev/null",
      "push",
      PUSH_URL,
      `${SHA}:refs/heads/${BRANCH}`,
    ]);
    assert.equal(args.includes("origin"), false);
    assert.deepEqual(commitArgs("feedback: card aaaaaaaa"), [
      "-c",
      "core.hooksPath=/dev/null",
      "commit",
      "-m",
      "feedback: card aaaaaaaa",
    ]);
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
  });
});
