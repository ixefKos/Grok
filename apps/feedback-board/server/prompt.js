export function buildAgentPrompt(card) {
  const title = card && typeof card.title === "string" ? card.title : "";
  const notes = card && typeof card.notes === "string" ? card.notes : "";
  return [
    "You are working one feedback card in a local git worktree.",
    "",
    "Edit only files inside these folders:",
    "- apps/thedailylumen/",
    "- apps/feedback-board/",
    "",
    "Do not edit any other path.",
    "Do not run git push.",
    "Do not run gh.",
    "Do not post, reply, upload, or send anything over the network.",
    "Do not touch anything named Lumen pipeline.",
    "Do not touch the ixefKos/Lumen repository.",
    "Do not merge pull requests.",
    "",
    "Card title:",
    title,
    "",
    "Card notes:",
    notes,
  ].join("\n");
}
