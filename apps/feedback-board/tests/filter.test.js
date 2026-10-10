import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { collectInboxIssues, isHardDropped } from "../server/filter.js";

function issue(overrides) {
  return {
    number: 1,
    title: "Synthetic title alpha",
    body: "Synthetic body beta.\nx_author_id: 1001\nx_handle: @example_author",
    author: { login: "someone", id: 1 },
    ...overrides,
  };
}

describe("inbox hard drop", () => {
  it("drops an exact x_author_id line for the blocked id", () => {
    assert.equal(
      isHardDropped(
        issue({
          body: "Synthetic body beta.\nx_author_id: 2416162544\nx_handle: @example_author",
        }),
      ),
      true,
    );
  });

  it("drops an issue when the x_author_id line is missing or not exact", () => {
    assert.equal(isHardDropped(issue({ body: "Synthetic body beta." })), true);
    assert.equal(isHardDropped(issue({ body: "x_author_id:2416162544" })), true);
    assert.equal(isHardDropped(issue({ body: "x_author_id: " })), true);
    assert.equal(isHardDropped(issue({ body: "prefix x_author_id: 1001" })), true);
    assert.equal(isHardDropped({ number: 3, title: "Plain" }), true);
    assert.equal(isHardDropped({ number: 4, title: "Plain", body: null }), true);
  });

  it("drops when any exact author id line is the blocked id", () => {
    assert.equal(
      isHardDropped(issue({ body: "x_author_id: 1001\nx_author_id: 2416162544" })),
      true,
    );
  });

  it("drops the handle in any case in the title or body", () => {
    assert.equal(isHardDropped(issue({ title: "reply from @Nanalyzetweets" })), true);
    assert.equal(
      isHardDropped(issue({ body: "see @NANALYZETWEETS today\nx_author_id: 1001" })),
      true,
    );
    assert.equal(isHardDropped(issue({ title: "@nanalyzetweets" })), true);
  });

  it("keeps a card with a different exact author id and no blocked handle", () => {
    assert.equal(isHardDropped(issue()), false);
  });

  it("does not use the GitHub author field", () => {
    const kept = issue({
      author: { login: "nanalyzetweets", id: 2416162544 },
    });
    assert.equal(isHardDropped(kept), false);
  });

  it("keeps the handle text when the @ is missing", () => {
    assert.equal(
      isHardDropped(issue({ body: "nanalyzetweets without a mention\nx_author_id: 1001" })),
      false,
    );
  });

  it("does not drop a prose mention of the id when a different exact line is present", () => {
    assert.equal(
      isHardDropped(
        issue({
          body: "A passing number 2416162544 appears in prose.\nx_author_id: 1001\nx_handle: @example_author",
        }),
      ),
      false,
    );
  });
});

describe("inbox de-dupe", () => {
  it("keeps new issues, drops blocked ones, and skips known numbers", () => {
    const existing = [{ issueNumber: 7, title: "Already here" }];
    const issues = [
      issue({ number: 7, title: "Already here" }),
      issue({ number: 8, title: "Blocked @nanalyzetweets" }),
      issue({ number: 9, title: "Missing author line", body: "No contract line" }),
      issue({
        number: 10,
        title: "Fresh synthetic",
        body: "Thanks\nx_author_id: 1002\nx_handle: @example_author",
      }),
      issue({ number: 10, title: "Fresh synthetic again" }),
      { number: "11", title: "Not a number" },
    ];
    const accepted = collectInboxIssues(existing, issues);
    assert.deepEqual(
      accepted.map((item) => item.number),
      [10],
    );
  });
});
