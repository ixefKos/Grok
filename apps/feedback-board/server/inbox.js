import { loadConfig } from "./config.js";
import { issueCard } from "./cards.js";
import { runProcess } from "./exec.js";
import { collectInboxIssues } from "./filter.js";
import { mutateState, readState } from "./store.js";

const PR_URL = /^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+$/;

function commandError(error, fallback) {
  if (error && error.code === "ENOENT") return `${fallback} is not available.`;
  return error && error.message ? error.message : `${fallback} failed.`;
}

export async function pullInbox(config = loadConfig()) {
  let listed;
  try {
    listed = await runProcess(
      "gh",
      [
        "issue",
        "list",
        "--repo",
        config.inboxRepo,
        "--state",
        "open",
        "--json",
        "number,title,body,author,createdAt,url",
      ],
      { timeoutMs: 20000 },
    );
  } catch (error) {
    return { ok: false, error: commandError(error, "gh"), added: 0 };
  }
  if (listed.code !== 0) {
    const detail = (listed.stderr || listed.stdout || "gh issue list failed").trim();
    return { ok: false, error: detail, added: 0 };
  }
  let issues;
  try {
    issues = JSON.parse(listed.stdout);
  } catch {
    return { ok: false, error: "gh issue list did not return JSON.", added: 0 };
  }
  if (!Array.isArray(issues)) {
    return { ok: false, error: "gh issue list did not return a list.", added: 0 };
  }
  let added = 0;
  const saved = await mutateState((state) => {
    const fresh = collectInboxIssues(state.cards, issues);
    added = fresh.length;
    for (const issue of fresh) state.cards.unshift(issueCard(issue));
    return { added };
  });
  if (!saved.ok) return { ok: false, error: saved.error || "Could not save inbox cards.", added: 0 };
  return { ok: true, added, error: null };
}

export async function refreshPullRequests() {
  const state = await readState();
  const targets = state.cards.filter(
    (card) => card.column === "pr" && typeof card.prUrl === "string" && PR_URL.test(card.prUrl),
  );
  const mergedIds = [];
  const errors = [];
  for (const card of targets) {
    let viewed;
    try {
      viewed = await runProcess("gh", ["pr", "view", card.prUrl, "--json", "state,mergedAt"], {
        timeoutMs: 20000,
      });
    } catch (error) {
      errors.push(commandError(error, "gh"));
      continue;
    }
    if (viewed.code !== 0) {
      errors.push((viewed.stderr || viewed.stdout || "gh pr view failed").trim());
      continue;
    }
    let payload;
    try {
      payload = JSON.parse(viewed.stdout);
    } catch {
      errors.push(`Could not read pull request status for ${card.prUrl}.`);
      continue;
    }
    const merged = Boolean(payload.mergedAt) || String(payload.state || "").toUpperCase() === "MERGED";
    if (merged) mergedIds.push(card.id);
  }
  if (mergedIds.length) {
    await mutateState((current) => {
      for (const card of current.cards) {
        if (!mergedIds.includes(card.id)) continue;
        card.column = "done";
        card.runStatus = "merged";
        card.message = null;
        card.updatedAt = new Date().toISOString();
      }
    });
  }
  return { ok: errors.length === 0, errors, moved: mergedIds.length };
}
