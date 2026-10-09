import fs from "node:fs";
import path from "node:path";

export const ALLOWED_PREFIXES = ["apps/thedailylumen/", "apps/feedback-board/"];

export function pathContainsLumen(filePath) {
  return String(filePath).toLowerCase().includes("lumen");
}

export function parseGitHubRemote(url) {
  if (typeof url !== "string") return null;
  const trimmed = url.trim();
  if (!trimmed || /[\s\0]/.test(trimmed)) return null;
  let host = "";
  let repoPath = trimmed.replace(/\.git$/i, "").replace(/\/+$/, "");
  const scp = repoPath.match(/^git@([^:]+):(.+)$/);
  if (scp) {
    host = scp[1];
    repoPath = scp[2];
  } else if (repoPath.includes("://")) {
    let parsed;
    try {
      parsed = new URL(repoPath);
    } catch {
      return null;
    }
    host = parsed.hostname;
    repoPath = parsed.pathname.replace(/^\/+/, "");
  } else {
    return null;
  }
  const parts = repoPath.split("/").filter(Boolean);
  if (parts.length !== 2) return null;
  return { host, owner: parts[0], repo: parts[1] };
}

export function isGrokOrigin(url) {
  const parsed = parseGitHubRemote(url);
  if (!parsed) return false;
  return parsed.host === "github.com" && parsed.owner === "ixefKos" && parsed.repo === "Grok";
}

export function assessWorkCopyPath(workCopyPath, realWorkCopyPath = workCopyPath) {
  if (typeof workCopyPath !== "string" || !workCopyPath.trim()) {
    return { ok: false, reason: "Work copy path is not set." };
  }
  if (pathContainsLumen(workCopyPath) || pathContainsLumen(realWorkCopyPath)) {
    return { ok: false, reason: "Work copy path contains Lumen." };
  }
  return { ok: true };
}

export function evaluateStartGuards(input) {
  const source = input || {};
  if (source.agentsEnabled !== true) {
    return { ok: false, reason: "Agents are off." };
  }
  if (source.locked) {
    return { ok: false, reason: "This card already started a run." };
  }
  if (source.anotherRunning) {
    return { ok: false, reason: "Another run is already in progress." };
  }
  const cap = Number.isInteger(source.dailyCap) ? source.dailyCap : 3;
  const runsToday = Number.isInteger(source.runsToday) ? source.runsToday : 0;
  if (runsToday >= cap) {
    return { ok: false, reason: `Daily run cap (${cap}) is reached.` };
  }
  const pathCheck = assessWorkCopyPath(source.workCopyPath, source.realWorkCopyPath);
  if (!pathCheck.ok) return pathCheck;
  if (source.skipOriginCheck === true) return { ok: true };
  if (!isGrokOrigin(source.originUrl)) {
    return { ok: false, reason: "Work copy origin is not ixefKos/Grok." };
  }
  return { ok: true };
}

const SHA = /^[0-9a-f]{40}$/i;

function remoteLines(text) {
  return String(text ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

export const LOCAL_CONFIG_PATTERN = "^(url|include|include[iI][fF])\\.";

export function evaluateRemoteGuard({ fetchUrls, pushUrls } = {}) {
  const fetchList = remoteLines(fetchUrls);
  const pushList = remoteLines(pushUrls);
  if (fetchList.length === 0 || pushList.length === 0) {
    return { ok: false, reason: "Work copy origin is not ixefKos/Grok." };
  }
  for (const url of [...fetchList, ...pushList]) {
    if (!isGrokOrigin(url)) {
      return { ok: false, reason: "Work copy origin is not ixefKos/Grok." };
    }
  }
  return { ok: true };
}

export function localConfigHit(text) {
  return remoteLines(text).length > 0;
}

function worktreeScopeUnavailable(result) {
  const stderr = String((result && result.stderr) || "");
  return result && result.code === 128 && stderr.includes("multiple working trees");
}

export function assessLocalConfig(results) {
  for (const result of results || []) {
    if (!result || result.signal || !Number.isInteger(result.code)) {
      return { ok: false, reason: "Could not read git url config." };
    }
    if (localConfigHit(result.stdout)) {
      return { ok: false, reason: "Work copy has a local url.* or include.* git config key." };
    }
    if (result.code === 0 || result.code === 1) continue;
    if (worktreeScopeUnavailable(result)) continue;
    return { ok: false, reason: "Could not read git url config." };
  }
  return { ok: true };
}

export function gateDiffArgs(baseSha, head = "HEAD") {
  if (!SHA.test(String(baseSha))) throw new Error("baseSha is not pinned.");
  if (head !== "HEAD" && !SHA.test(String(head))) throw new Error("head is not pinned.");
  const range = `${String(baseSha)}..${head}`;
  if (range.includes("origin/main")) throw new Error("diff range must not use origin/main.");
  return ["diff", "--name-only", "--no-renames", range];
}

export function gateRawArgs(baseSha, head = "HEAD") {
  const range = gateDiffArgs(baseSha, head).at(-1);
  return ["diff", "--raw", "--no-renames", range];
}

export function symlinkPathsFromRaw(raw) {
  const paths = [];
  for (const line of String(raw ?? "").split(/\r?\n/)) {
    if (!line.startsWith(":")) continue;
    const tab = line.indexOf("\t");
    if (tab < 0) continue;
    const parts = line.slice(0, tab).split(" ");
    const oldMode = parts[0].slice(1);
    const newMode = parts[1];
    if (oldMode !== "120000" && newMode !== "120000") continue;
    let filePath = line.slice(tab + 1);
    if (filePath.startsWith('"') && filePath.endsWith('"')) filePath = filePath.slice(1, -1);
    if (filePath) paths.push(filePath);
  }
  return paths;
}

export function symlinkPathsOnDisk(cwd, paths) {
  const root = path.resolve(cwd);
  const links = [];
  for (const rel of paths || []) {
    const name = String(rel).trim();
    if (!name) continue;
    const full = path.resolve(root, name);
    if (full !== root && !full.startsWith(`${root}${path.sep}`)) continue;
    try {
      if (fs.lstatSync(full).isSymbolicLink()) links.push(name);
    } catch {
      // A missing path is handled by the name gate.
    }
  }
  return links;
}

export function assertHeadOnBranch({ headSha, branchSha, branch, symbolicHead } = {}) {
  if (!/^feedback\/card-[0-9a-f-]{36}$/i.test(String(branch || ""))) {
    return { ok: false, reason: "HEAD is not the card branch." };
  }
  const expected = `refs/heads/${branch}`;
  const head = String(headSha || "").trim().toLowerCase();
  const ref = String(branchSha || "").trim().toLowerCase();
  const symbolic = String(symbolicHead || "").trim();
  if (symbolic !== expected || !SHA.test(head) || head !== ref) {
    return { ok: false, reason: "HEAD is not the card branch." };
  }
  return { ok: true };
}

export function listChangedPaths(...outputs) {
  const paths = [];
  for (const output of outputs) {
    for (const line of String(output ?? "").split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed) paths.push(trimmed);
    }
  }
  return paths;
}

export function findOutOfScopePaths(paths, symlinks = []) {
  const blocked = [];
  const seen = new Set();
  for (const raw of paths || []) {
    const original = String(raw).trim();
    if (!original || seen.has(original)) continue;
    const normalized = path.posix.normalize(original.replace(/\\/g, "/")).replace(/^\.\/+/, "");
    const allowed = ALLOWED_PREFIXES.some((prefix) => normalized.startsWith(prefix));
    const escapes =
      normalized === ".." || normalized.startsWith("../") || normalized.startsWith("/");
    if (!allowed || escapes) {
      seen.add(original);
      blocked.push(original);
    }
  }
  for (const raw of symlinks || []) {
    const original = String(raw).trim();
    if (!original || seen.has(original)) continue;
    seen.add(original);
    blocked.push(original);
  }
  return blocked;
}
