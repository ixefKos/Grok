import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runProcess } from "./exec.js";
import { ALLOWED_PREFIXES } from "./guard.js";

export const MAX_FILE_BYTES = 2 * 1024 * 1024;
export const MAX_TREE_FILES = 200;

const WALK_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "tree_walk.py");

export function isAllowedRel(rel) {
  const name = String(rel || "").replace(/\\/g, "/");
  return ALLOWED_PREFIXES.some((prefix) => name.startsWith(prefix));
}

function emptyWalk(reason) {
  return { ok: false, reason, blocked: [], agentFiles: [], allowed: new Map(), meta: new Map() };
}

function policyFile(policy) {
  if (!policy) return { args: [], cleanup() {} };
  const file = path.join(os.tmpdir(), `feedback-board-policy-${crypto.randomBytes(8).toString("hex")}.json`);
  fs.writeFileSync(
    file,
    JSON.stringify({
      inodes: policy.inodes || [],
      spawn: Number.isFinite(policy.spawnTime) ? policy.spawnTime : null,
      base: policy.base || {},
    }),
  );
  return {
    args: ["walk", file],
    cleanup() {
      try {
        fs.unlinkSync(file);
      } catch {
        // The policy file is already gone.
      }
    },
  };
}

export function decodeTreeWalk(buffer) {
  let payload;
  try {
    payload = JSON.parse(Buffer.from(buffer || "").toString("utf8"));
  } catch {
    return emptyWalk("Could not read the agent tree.");
  }
  if (!payload || payload.ok !== true) {
    return {
      ok: false,
      reason: payload && payload.reason ? payload.reason : "Could not read the agent tree.",
      blocked: payload && Array.isArray(payload.blocked) ? payload.blocked : [],
      agentFiles: [],
      allowed: new Map(),
      meta: new Map(),
    };
  }
  const allowed = new Map();
  const meta = new Map();
  const agentFiles = [];
  for (const file of payload.files || []) {
    if (!file || typeof file.rel !== "string" || typeof file.bytes !== "string") {
      return emptyWalk("Could not read the agent tree.");
    }
    if (!isAllowedRel(file.rel)) return emptyWalk("Could not read the agent tree.");
    const bytes = Buffer.from(file.bytes, "base64");
    if (bytes.length > MAX_FILE_BYTES) return emptyWalk("Agent tree contains a file over the size cap.");
    allowed.set(file.rel, bytes);
    meta.set(file.rel, {
      dev: file.dev == null ? "" : String(file.dev),
      ino: file.ino == null ? "" : String(file.ino),
      birth: typeof file.birth === "number" ? file.birth : null,
    });
    agentFiles.push(file.rel);
  }
  for (const rel of payload.outside || []) {
    if (typeof rel !== "string" || isAllowedRel(rel)) return emptyWalk("Could not read the agent tree.");
    agentFiles.push(rel);
  }
  if (allowed.size > MAX_TREE_FILES) {
    return emptyWalk("Agent tree contains more than 200 files in the allowed folders.");
  }
  return { ok: true, reason: null, blocked: [], agentFiles, allowed, meta };
}

function pythonWalk(root, policy) {
  const policyArgs = policyFile(policy);
  const args = policy ? ["walk", root, ...policyArgs.args.slice(1)] : [root];
  return { args, cleanup: policyArgs.cleanup };
}

export function inspectAgentTree(root, policy) {
  const planned = pythonWalk(root, policy);
  try {
    const result = spawnSync("python3", [WALK_SCRIPT, ...planned.args], {
      cwd: path.dirname(WALK_SCRIPT),
      timeout: 20000,
      maxBuffer: 64 * 1024 * 1024,
    });
    if (result.error || result.signal || result.status !== 0) return emptyWalk("Could not read the agent tree.");
    return decodeTreeWalk(result.stdout);
  } finally {
    planned.cleanup();
  }
}

export async function readAgentTree(root, policy) {
  const planned = pythonWalk(root, policy);
  try {
    const result = await runProcess("python3", [WALK_SCRIPT, ...planned.args], {
      timeoutMs: 20000,
      cwd: path.dirname(WALK_SCRIPT),
    });
    if (result.signal || result.code !== 0) return emptyWalk("Could not read the agent tree.");
    return decodeTreeWalk(result.stdoutBuffer);
  } catch {
    return emptyWalk("Could not read the agent tree.");
  } finally {
    planned.cleanup();
  }
}

export function snapshotAgentTree(root) {
  const result = spawnSync("python3", [WALK_SCRIPT, "snapshot", root], {
    cwd: path.dirname(WALK_SCRIPT),
    timeout: 20000,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error || result.signal || result.status !== 0) {
    return { ok: false, reason: "Could not read the agent tree.", inodes: [] };
  }
  try {
    const payload = JSON.parse(Buffer.from(result.stdout || "").toString("utf8"));
    if (!payload || payload.ok !== true || !Array.isArray(payload.inodes)) {
      return { ok: false, reason: "Could not read the agent tree.", inodes: [] };
    }
    return { ok: true, inodes: payload.inodes.map((inode) => String(inode)) };
  } catch {
    return { ok: false, reason: "Could not read the agent tree.", inodes: [] };
  }
}

export function removeAgentTree(root) {
  if (!root) return { ok: true };
  const result = spawnSync("python3", [WALK_SCRIPT, "rmtree", root], {
    cwd: path.dirname(WALK_SCRIPT),
    timeout: 20000,
    maxBuffer: 1024 * 1024,
  });
  if (result.error || result.signal || result.status !== 0) {
    return { ok: false, reason: "Could not remove the agent tree." };
  }
  try {
    const payload = JSON.parse(Buffer.from(result.stdout || "").toString("utf8"));
    if (!payload || payload.ok !== true) return { ok: false, reason: "Could not remove the agent tree." };
    return { ok: true };
  } catch {
    return { ok: false, reason: "Could not remove the agent tree." };
  }
}

export function baseContentHashes(blobs) {
  const base = {};
  for (const [rel, bytes] of blobs || []) {
    base[rel] = crypto.createHash("sha256").update(bytes).digest("hex");
  }
  return base;
}

export function rejectMovedIn(inspected, baseline, blobs) {
  const inodes = new Set((baseline && baseline.inodes) || []);
  const spawn = baseline && Number.isFinite(baseline.spawnTime) ? baseline.spawnTime : null;
  const blocked = [];
  for (const [rel, bytes] of inspected.allowed || []) {
    const base = blobs && blobs.get(rel);
    if (base && Buffer.isBuffer(base) && base.equals(bytes)) continue;
    const meta = inspected.meta && inspected.meta.get(rel);
    if (meta && meta.dev && meta.ino && inodes.has(`${meta.dev}:${meta.ino}`)) continue;
    if (meta && spawn !== null && typeof meta.birth === "number" && meta.birth >= spawn) continue;
    blocked.push(rel);
  }
  if (!blocked.length) return null;
  return {
    ok: false,
    reason: "Agent tree contains a file moved in from outside this run.",
    blocked,
  };
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

function unsafeRel(rel) {
  if (typeof rel !== "string" || !rel) return true;
  for (let index = 0; index < rel.length; index += 1) {
    const code = rel.charCodeAt(index);
    if (rel[index] === "\\" || code < 32 || code === 127) return true;
  }
  return false;
}

function lstatOrNull(file) {
  try {
    return fs.lstatSync(file);
  } catch (error) {
    if (error && error.code === "ENOENT") return null;
    throw error;
  }
}

function assertRealDirectory(file) {
  const st = fs.lstatSync(file);
  if (st.isSymbolicLink() || !st.isDirectory()) {
    throw new Error("Refusing to follow a symlink in the fresh worktree.");
  }
}

function mkdirNoFollow(root, relDir) {
  let cursor = root;
  for (const part of relDir.split("/")) {
    if (!part || part === ".") continue;
    cursor = path.join(cursor, part);
    const existing = lstatOrNull(cursor);
    if (!existing) {
      fs.mkdirSync(cursor);
    }
    assertRealDirectory(cursor);
  }
}

export function applyTreeChanges(freshRoot, changes) {
  const root = path.resolve(freshRoot);
  assertRealDirectory(root);
  for (const change of changes || []) {
    if (unsafeRel(change.path)) throw new Error("Refusing to write an unsafe path.");
    const dest = path.resolve(root, change.path);
    const rel = path.relative(root, dest);
    if (!rel || rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
      throw new Error("Refusing to write outside the fresh worktree.");
    }
    const posix = rel.split(path.sep).join("/");
    if (!isAllowedRel(posix)) throw new Error("Refusing to write outside the allowed folders.");
    const parentRel = posix.includes("/") ? posix.slice(0, posix.lastIndexOf("/")) : "";
    if (parentRel) mkdirNoFollow(root, parentRel);
    if (change.kind === "delete") {
      const st = lstatOrNull(dest);
      if (!st) continue;
      if (st.isSymbolicLink()) {
        fs.unlinkSync(dest);
        continue;
      }
      fs.rmSync(dest, { recursive: true, force: true });
      continue;
    }
    const existing = lstatOrNull(dest);
    if (existing && existing.isSymbolicLink()) {
      throw new Error("Refusing to follow a symlink in the fresh worktree.");
    }
    const flags = fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW | fs.constants.O_CLOEXEC;
    const fd = existing
      ? fs.openSync(dest, flags | fs.constants.O_TRUNC)
      : fs.openSync(dest, flags | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o644);
    try {
      const bytes = Buffer.isBuffer(change.bytes) ? change.bytes : Buffer.from(change.bytes || "");
      fs.writeSync(fd, bytes);
    } finally {
      fs.closeSync(fd);
    }
  }
}

export function freshWorktreePath(workCopy, cardId) {
  return path.join(path.dirname(path.resolve(workCopy)), "feedback-board-worktrees", `${cardId}-publish`);
}
