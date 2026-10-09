import fs from "node:fs";
import path from "node:path";

export const BOARD_GIT_CONFIG_ARGS = [
  "-c",
  "core.fsmonitor=false",
  "-c",
  "http.sslVerify=true",
  "-c",
  "http.proxy=",
  "-c",
  "core.sshCommand=",
  "-c",
  "core.hooksPath=/dev/null",
];

export function withBoardGitArgs(args) {
  return [...BOARD_GIT_CONFIG_ARGS, ...(args || [])];
}

export function assertWorktreeGitFile(worktreePath, gitDir) {
  const dotGit = path.join(worktreePath, ".git");
  let st;
  try {
    st = fs.lstatSync(dotGit);
  } catch {
    return { ok: false, reason: "Worktree gitdir file is missing." };
  }
  if (st.isSymbolicLink() || !st.isFile()) {
    return { ok: false, reason: "Worktree gitdir file is not a regular file." };
  }
  let text;
  try {
    text = fs.readFileSync(dotGit, "utf8");
  } catch {
    return { ok: false, reason: "Worktree gitdir file is missing." };
  }
  const expected = `gitdir: ${gitDir}`;
  if (text !== `${expected}\n` && text !== expected) {
    return { ok: false, reason: "Worktree gitdir was rewritten." };
  }
  return { ok: true };
}

export function postRunGitPlan({ worktreePath, gitDir, args, env = {} } = {}) {
  const verdict = assertWorktreeGitFile(worktreePath, gitDir);
  if (!verdict.ok) {
    return { ok: false, ran: false, reason: verdict.reason, args: null, env: null };
  }
  return {
    ok: true,
    ran: true,
    reason: null,
    args: withBoardGitArgs(args),
    env: {
      ...env,
      GIT_DIR: gitDir,
      GIT_WORK_TREE: path.resolve(worktreePath),
    },
  };
}

export async function runIfPinned(plan, spawnImpl) {
  if (!plan || !plan.ok) {
    return { ok: false, ran: false, reason: plan ? plan.reason : "Worktree gitdir was rewritten." };
  }
  const result = await spawnImpl(plan.args, plan.env);
  return { ok: true, ran: true, result };
}

export function porcelainListsWorktree(porcelain, worktreePath) {
  const wanted = path.resolve(worktreePath);
  return String(porcelain ?? "")
    .split(/\r?\n/)
    .some((line) => line.startsWith("worktree ") && path.resolve(line.slice("worktree ".length).trim()) === wanted);
}

export function findRegisteredGitDir(commonDir, worktreePath) {
  const root = path.resolve(commonDir, "worktrees");
  const expected = path.resolve(worktreePath, ".git");
  let found = null;
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const pointer = path.join(root, entry.name, "gitdir");
    let st;
    try {
      st = fs.lstatSync(pointer);
    } catch {
      continue;
    }
    if (st.isSymbolicLink() || !st.isFile()) continue;
    const text = fs.readFileSync(pointer, "utf8").replace(/\r?\n$/, "");
    if (path.resolve(text) !== expected) continue;
    if (found) return null;
    found = path.join(root, entry.name);
  }
  return found;
}

export function failedSpawnCleanupArgs(worktreePath, branch) {
  return {
    remove: ["worktree", "remove", "--force", worktreePath],
    branch: ["branch", "-D", branch],
  };
}
