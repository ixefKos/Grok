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

export function evaluateRemoteGuard({ fetchUrls, pushUrls, urlConfigText } = {}) {
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
  if (remoteLines(urlConfigText).length > 0) {
    return { ok: false, reason: "Work copy has a url.* git config key." };
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

export function findOutOfScopePaths(paths) {
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
  return blocked;
}
