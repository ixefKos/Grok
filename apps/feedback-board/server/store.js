import fs from "node:fs/promises";
import path from "node:path";
import { appRoot } from "./config.js";

function dataFile(root) {
  return path.join(root, "data", "cards.json");
}

function emptyState() {
  return { cards: [], usage: { date: "", count: 0 } };
}

export async function readState(root = appRoot()) {
  try {
    const text = await fs.readFile(dataFile(root), "utf8");
    const parsed = JSON.parse(text);
    if (!parsed || !Array.isArray(parsed.cards)) return emptyState();
    if (!parsed.usage || typeof parsed.usage !== "object") {
      parsed.usage = { date: "", count: 0 };
    }
    return parsed;
  } catch (error) {
    if (error && error.code === "ENOENT") return emptyState();
    throw error;
  }
}

export async function writeState(state, root = appRoot()) {
  const file = dataFile(root);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await fs.rename(temporary, file);
}

let chain = Promise.resolve();

export function mutateState(mutator, root = appRoot()) {
  const run = chain.then(async () => {
    const state = await readState(root);
    const result = await mutator(state);
    if (result && result.ok === false) return result;
    await writeState(state, root);
    const extra = result && typeof result === "object" ? result : {};
    return { ok: true, ...extra, state };
  });
  chain = run.then(
    () => {},
    () => {},
  );
  return run;
}
