import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { evaluateStartGuards, isGrokOrigin } from "../server/guard.js";

const allowed = {
  agentsEnabled: true,
  workCopyPath: "/opt/grok-work",
  originUrl: "https://github.com/ixefKos/Grok.git",
  locked: false,
  anotherRunning: false,
  runsToday: 0,
  dailyCap: 3,
};

describe("work copy path guard", () => {
  it("allows a Grok origin whose path does not contain Lumen", () => {
    assert.deepEqual(evaluateStartGuards(allowed), { ok: true });
    assert.equal(isGrokOrigin("git@github.com:ixefKos/Grok.git"), true);
    assert.equal(isGrokOrigin("ssh://git@github.com/ixefKos/Grok"), true);
    assert.equal(isGrokOrigin("https://github.com/ixefKos/Grok/"), true);
  });

  it("refuses a work copy path that contains Lumen", () => {
    for (const workCopyPath of [
      "/Users/xavier/Grok/Lumen",
      "/Users/xavier/src/lumen-copy",
      "/tmp/LUMEN/work",
      "/home/xavier/thedailylumen/Grok",
    ]) {
      const result = evaluateStartGuards({ ...allowed, workCopyPath });
      assert.equal(result.ok, false);
      assert.match(result.reason, /Lumen/);
    }
  });

  it("refuses when the resolved path contains Lumen", () => {
    const result = evaluateStartGuards({
      ...allowed,
      workCopyPath: "/opt/grok-work",
      realWorkCopyPath: "/opt/Lumen/grok-work",
    });
    assert.equal(result.ok, false);
    assert.match(result.reason, /Lumen/);
  });

  it("refuses an origin that is not ixefKos/Grok", () => {
    for (const originUrl of [
      "https://github.com/ixefKos/Lumen.git",
      "git@github.com:ixefKos/Lumen.git",
      "https://github.com/ixefKos/Grok-other.git",
      "https://github.com/other/Grok.git",
      "https://gitlab.com/ixefKos/Grok.git",
      "https://github.com/ixefkos/Grok.git",
      "",
    ]) {
      const result = evaluateStartGuards({ ...allowed, originUrl });
      assert.equal(result.ok, false, originUrl);
      assert.match(result.reason, /ixefKos\/Grok/);
    }
  });

  it("refuses a missing work copy path", () => {
    const result = evaluateStartGuards({ ...allowed, workCopyPath: "  " });
    assert.equal(result.ok, false);
    assert.match(result.reason, /not set/);
  });

  it("refuses when agents are off, the card is locked, a run is active, or the cap is spent", () => {
    assert.match(evaluateStartGuards({ ...allowed, agentsEnabled: false }).reason, /off/);
    assert.match(evaluateStartGuards({ ...allowed, locked: true }).reason, /already started/);
    assert.match(evaluateStartGuards({ ...allowed, anotherRunning: true }).reason, /already in progress/);
    assert.match(evaluateStartGuards({ ...allowed, runsToday: 3 }).reason, /cap/);
  });
});
