import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { findOutOfScopePaths, listChangedPaths } from "../server/guard.js";

describe("changed-files gate", () => {
  it("allows files inside the two folders", () => {
    const paths = listChangedPaths(
      "apps/thedailylumen/index.html\napps/feedback-board/README.md\n",
      "apps/feedback-board/server/index.js\n",
    );
    assert.deepEqual(findOutOfScopePaths(paths), []);
  });

  it("blocks paths outside the two folders and keeps the allowed ones out of the list", () => {
    const diff = "apps/thedailylumen/index.html\nREADME.md\n";
    const untracked = "apps/other/note.txt\napps/feedback-board/src/App.jsx\n";
    assert.deepEqual(findOutOfScopePaths(listChangedPaths(diff, untracked)), [
      "README.md",
      "apps/other/note.txt",
    ]);
  });

  it("does not treat a lookalike folder as allowed", () => {
    assert.deepEqual(findOutOfScopePaths(["apps/thedailylumen-extra/index.html", "apps/feedback-board"]), [
      "apps/thedailylumen-extra/index.html",
      "apps/feedback-board",
    ]);
  });

  it("blocks paths that escape the allowed folders", () => {
    assert.deepEqual(
      findOutOfScopePaths([
        "apps/thedailylumen/../../README.md",
        "apps/feedback-board/../../etc/passwd",
        "../secrets",
      ]),
      ["apps/thedailylumen/../../README.md", "apps/feedback-board/../../etc/passwd", "../secrets"],
    );
  });

  it("allows a normalized path that stays inside an allowed folder", () => {
    assert.deepEqual(findOutOfScopePaths(["apps/thedailylumen/../feedback-board/README.md"]), []);
  });

  it("passes when nothing changed", () => {
    assert.deepEqual(findOutOfScopePaths(listChangedPaths("", "\n")), []);
  });
});
