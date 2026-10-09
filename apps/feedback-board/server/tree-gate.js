import fs from "node:fs";
import path from "node:path";
import { ALLOWED_PREFIXES } from "./guard.js";

export const MAX_FILE_BYTES = 2 * 1024 * 1024;
export const MAX_TREE_FILES = 200;

const META_NAMES = new Set([".gitattributes", ".gitmodules"]);

export function isAllowedRel(rel) {
  const name = String(rel || "").replace(/\\/g, "/");
  return ALLOWED_PREFIXES.some((prefix) => name.startsWith(prefix));
}

function fail(state, rel, reason) {
  if (!state.reason) state.reason = reason;
  if (rel) state.blocked.push(rel);
}

export function inspectAgentTree(root) {
  const state = {
    reason: null,
    blocked: [],
    agentFiles: [],
    allowed: new Map(),
  };

  function walk(dir, relDir) {
    let entries;
    try {
      const self = fs.lstatSync(dir);
      if (self.isSymbolicLink() || !self.isDirectory()) {
        fail(state, relDir || ".", "Agent tree contains a path that is not a directory.");
        return;
      }
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      fail(state, relDir || ".", "Could not read the agent tree.");
      return;
    }
    for (const entry of entries) {
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      const full = path.join(dir, entry.name);
      let st;
      try {
        st = fs.lstatSync(full);
      } catch {
        fail(state, rel, "Could not read the agent tree.");
        continue;
      }
      const parts = rel.split("/");
      if (entry.name === ".git" || parts.includes(".git")) {
        if (rel === ".git" && st.isFile() && !st.isSymbolicLink()) continue;
        fail(state, rel, "Agent tree contains a .git file or directory.");
        continue;
      }
      if (META_NAMES.has(entry.name)) {
        fail(state, rel, "Agent tree contains .gitattributes or .gitmodules.");
        continue;
      }
      if (st.isSymbolicLink()) {
        fail(state, rel, "Agent tree contains a symlink.");
        continue;
      }
      if (st.isSocket() || st.isFIFO() || st.isCharacterDevice() || st.isBlockDevice()) {
        fail(state, rel, "Agent tree contains a socket, fifo, or device.");
        continue;
      }
      if (st.isDirectory()) {
        walk(full, rel);
        continue;
      }
      if (!st.isFile()) {
        fail(state, rel, "Agent tree contains a file that is not a regular file.");
        continue;
      }
      state.agentFiles.push(rel);
      if (!isAllowedRel(rel)) continue;
      if (st.size > MAX_FILE_BYTES) {
        fail(state, rel, "Agent tree contains a file over the size cap.");
        continue;
      }
      if (state.allowed.size >= MAX_TREE_FILES) {
        fail(state, rel, "Agent tree contains more than 200 files in the allowed folders.");
        continue;
      }
      try {
        state.allowed.set(rel, fs.readFileSync(full));
      } catch {
        fail(state, rel, "Could not read the agent tree.");
      }
    }
  }

  walk(root, "");
  if (state.reason) {
    return {
      ok: false,
      reason: state.reason,
      blocked: state.blocked,
      agentFiles: state.agentFiles,
      allowed: state.allowed,
    };
  }
  return { ok: true, reason: null, blocked: [], agentFiles: state.agentFiles, allowed: state.allowed };
}

export function outsideDrift(agentFiles, baseFiles) {
  const agent = new Set((agentFiles || []).filter((rel) => !isAllowedRel(rel)));
  const base = new Set((baseFiles || []).filter((rel) => !isAllowedRel(rel)));
  const blocked = [];
  for (const rel of agent) if (!base.has(rel)) blocked.push(rel);
  for (const rel of base) if (!agent.has(rel)) blocked.push(rel);
  if (blocked.length) {
    return {
      ok: false,
      reason: "Agent tree differs from the base outside the allowed folders.",
      blocked,
    };
  }
  return { ok: true, blocked: [] };
}

export function planTreeChanges(allowed, baseBlobs, baseAllowedPaths) {
  const changes = [];
  const present = new Set(allowed ? allowed.keys() : []);
  for (const [rel, bytes] of allowed || []) {
    if (!baseBlobs || !baseBlobs.has(rel)) {
      changes.push({ path: rel, kind: "add", bytes });
      continue;
    }
    const base = baseBlobs.get(rel);
    if (!Buffer.isBuffer(base) || !base.equals(bytes)) {
      changes.push({ path: rel, kind: "modify", bytes });
    }
  }
  for (const rel of baseAllowedPaths || []) {
    if (!present.has(rel)) changes.push({ path: rel, kind: "delete" });
  }
  if (changes.length > MAX_TREE_FILES) {
    return {
      ok: false,
      reason: "Agent tree changes more than 200 files.",
      blocked: changes.map((change) => change.path),
      changes: [],
    };
  }
  return { ok: true, changes, blocked: [] };
}

export function judgeAgentTree({ agentWorktree, basePaths, baseBlobs }) {
  const inspected = inspectAgentTree(agentWorktree);
  if (!inspected.ok) return { ...inspected, changes: [] };
  const drift = outsideDrift(inspected.agentFiles, basePaths);
  if (!drift.ok) return { ...drift, changes: [] };
  const planned = planTreeChanges(
    inspected.allowed,
    baseBlobs,
    (basePaths || []).filter((rel) => isAllowedRel(rel)),
  );
  return planned;
}

export function applyTreeChanges(freshRoot, changes) {
  const root = path.resolve(freshRoot);
  for (const change of changes || []) {
    const dest = path.resolve(root, change.path);
    if (dest !== root && !dest.startsWith(`${root}${path.sep}`)) {
      throw new Error("Refusing to write outside the fresh worktree.");
    }
    if (change.kind === "delete") {
      fs.rmSync(dest, { force: true });
      continue;
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, change.bytes);
  }
}

export function freshWorktreePath(workCopy, cardId) {
  return path.join(path.dirname(path.resolve(workCopy)), "feedback-board-worktrees", `${cardId}-publish`);
}
