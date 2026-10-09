import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { collectInboxIssues, isHardDropped } from "../server/filter.js";

function issue(overrides) {
  return {
    number: 1,
    title: "A market note",
    body: "Watch the dollar index.",
    author: { login: "someone", id: 1 },
    ...overrides,
  };
}

describe("inbox hard drop", () => {
  it("drops a title that contains the author id", () => {
    assert.equal(isHardDropped(issue({ title: "from 2416162544" })), true);
  });

  it("drops a body that contains the author id", () => {
    assert.equal(isHardDropped(issue({ body: "author id 2416162544 said hi" })), true);
  });

  it("drops the handle in any case in the title or body", () => {
    assert.equal(isHardDropped(issue({ title: "reply from @Nanalyzetweets" })), true);
    assert.equal(isHardDropped(issue({ body: "see @NANALYZETWEETS today" })), true);
    assert.equal(isHardDropped(issue({ title: "@nanalyzetweets" })), true);
  });

  it("keeps a card whose title and body do not contain the id or handle", () => {
    assert.equal(isHardDropped(issue()), false);
  });

  it("does not use the GitHub author field", () => {
    const kept = issue({
      author: { login: "nanalyzetweets", id: 2416162544 },
    });
    assert.equal(isHardDropped(kept), false);
  });

  it("keeps the handle text when the @ is missing", () => {
    assert.equal(isHardDropped(issue({ body: "nanalyzetweets without a mention" })), false);
  });

  it("drops text that contains the blocked id as a substring", () => {
    assert.equal(isHardDropped(issue({ body: "ref 241616254499" })), true);
  });

  it("treats a missing body as empty", () => {
    assert.equal(isHardDropped({ number: 3, title: "Plain" }), false);
    assert.equal(isHardDropped({ number: 4, title: "Plain", body: null }), false);
  });
});

describe("inbox de-dupe", () => {
  it("keeps new issues, drops blocked ones, and skips known numbers", () => {
    const existing = [{ issueNumber: 7, title: "Already here" }];
    const issues = [
      issue({ number: 7, title: "Already here" }),
      issue({ number: 8, title: "Blocked @nanalyzetweets" }),
      issue({ number: 9, title: "Fresh note", body: "Thanks" }),
      issue({ number: 9, title: "Fresh note again" }),
      { number: "10", title: "Not a number" },
    ];
    const accepted = collectInboxIssues(existing, issues);
    assert.deepEqual(
      accepted.map((item) => item.number),
      [9],
    );
  });
});
