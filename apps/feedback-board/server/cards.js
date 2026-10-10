import { randomUUID } from "node:crypto";
import { mutateState } from "./store.js";

const MANUAL_COLUMNS = new Set(["inbox", "in_progress", "pr", "done"]);

function stamp(card) {
  card.updatedAt = new Date().toISOString();
}

export async function addTypedCard({ title, notes }) {
  const cleanTitle = typeof title === "string" ? title.trim() : "";
  const cleanNotes = typeof notes === "string" ? notes.trim() : "";
  if (!cleanTitle) return { ok: false, status: 400, error: "A title is required." };
  if (cleanTitle.length > 200) return { ok: false, status: 400, error: "Title is too long." };
  if (cleanNotes.length > 20000) return { ok: false, status: 400, error: "Notes are too long." };
  const now = new Date().toISOString();
  const card = {
    id: randomUUID(),
    title: cleanTitle,
    notes: cleanNotes,
    column: "inbox",
    issueNumber: null,
    issueUrl: null,
    locked: false,
    runStatus: null,
    outOfScopePaths: [],
    prUrl: null,
    message: null,
    createdAt: now,
    updatedAt: now,
  };
  return mutateState((state) => {
    state.cards.unshift(card);
    return { card };
  });
}

export async function moveCard(cardId, column) {
  if (!MANUAL_COLUMNS.has(column)) {
    return { ok: false, status: 400, error: "Drop the card on Todo to file or start it." };
  }
  return mutateState((state) => {
    const card = state.cards.find((item) => item.id === cardId);
    if (!card) return { ok: false, status: 404, error: "Card not found." };
    if (card.runStatus === "running") {
      return { ok: false, status: 409, error: "This card is running." };
    }
    card.column = column;
    if (card.message === "Agents are off. No run started.") card.message = null;
    stamp(card);
  });
}

export async function fileCardInTodo(cardId) {
  return mutateState((state) => {
    const card = state.cards.find((item) => item.id === cardId);
    if (!card) return { ok: false, status: 404, error: "Card not found." };
    if (card.runStatus === "running") {
      return { ok: false, status: 409, error: "This card is running." };
    }
    if (card.locked) {
      return { ok: false, status: 409, error: "This card already started a run." };
    }
    card.column = "todo";
    card.message = "Agents are off. No run started.";
    stamp(card);
  });
}

export function issueCard(issue) {
  const now = new Date().toISOString();
  const title =
    typeof issue.title === "string" && issue.title.trim()
      ? issue.title.trim()
      : `Issue ${issue.number}`;
  return {
    id: randomUUID(),
    title,
    notes: typeof issue.body === "string" ? issue.body : "",
    column: "inbox",
    issueNumber: issue.number,
    issueUrl: typeof issue.url === "string" ? issue.url : null,
    locked: false,
    runStatus: null,
    outOfScopePaths: [],
    prUrl: null,
    message: null,
    createdAt: now,
    updatedAt: now,
  };
}
