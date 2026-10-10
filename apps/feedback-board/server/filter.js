export const BLOCKED_AUTHOR_ID = "2416162544";
export const BLOCKED_HANDLE = "@nanalyzetweets";

const AUTHOR_LINE = /^x_author_id: ([0-9]+)$/;

export function issueText(issue) {
  const title = issue && typeof issue.title === "string" ? issue.title : "";
  const body = issue && typeof issue.body === "string" ? issue.body : "";
  return `${title}\n${body}`;
}

export function authorIds(issue) {
  const ids = [];
  for (const line of issueText(issue).split(/\r?\n/)) {
    const match = line.match(AUTHOR_LINE);
    if (match) ids.push(match[1]);
  }
  return ids;
}

export function isHardDropped(issue) {
  const ids = authorIds(issue);
  if (ids.length === 0 || ids.some((id) => id === BLOCKED_AUTHOR_ID)) return true;
  return issueText(issue).toLowerCase().includes(BLOCKED_HANDLE);
}

export function collectInboxIssues(existingCards, issues) {
  const known = new Set();
  for (const card of existingCards || []) {
    if (card && Number.isInteger(card.issueNumber)) known.add(card.issueNumber);
  }
  const accepted = [];
  for (const issue of issues || []) {
    if (!issue || !Number.isInteger(issue.number)) continue;
    if (isHardDropped(issue)) continue;
    if (known.has(issue.number)) continue;
    known.add(issue.number);
    accepted.push(issue);
  }
  return accepted;
}
