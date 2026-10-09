export const BLOCKED_AUTHOR_ID = "2416162544";
export const BLOCKED_HANDLE = "@nanalyzetweets";

export function issueText(issue) {
  const title = issue && typeof issue.title === "string" ? issue.title : "";
  const body = issue && typeof issue.body === "string" ? issue.body : "";
  return `${title}\n${body}`;
}

export function isHardDropped(issue) {
  const haystack = issueText(issue).toLowerCase();
  return haystack.includes(BLOCKED_AUTHOR_ID) || haystack.includes(BLOCKED_HANDLE);
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
