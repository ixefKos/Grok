import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { RUN_MARKER_ENV } from "./tree-idle.js";

export const SANDBOX_PROFILE = "strict";
export const PUSH_URL = "https://github.com/ixefKos/Grok.git";

export const BASH_DENY_RULES = [
  "Bash(git push*)",
  "Bash(gh *)",
  "Bash(git config*)",
  "Bash(git update-ref*)",
  "Bash(git checkout*)",
  "Bash(git switch*)",
  "Bash(git remote*)",
];

const OUTSIDE_ROOTS = ["bin", "etc", "home", "Users", "opt", "private", "root", "tmp", "usr", "var", "Volumes"];

export function writeDeniesOutsideWorktree(worktreePath) {
  const root = path.resolve(worktreePath).replace(/\\/g, "/");
  const denies = ["Edit(../**)"];
  for (const name of OUTSIDE_ROOTS) {
    const prefix = `/${name}`;
    if (root === prefix || root.startsWith(`${prefix}/`)) continue;
    denies.push(`Edit(${prefix}/**)`);
  }
  return denies;
}

export function grokDenyRules(worktreePath) {
  return [...BASH_DENY_RULES, ...writeDeniesOutsideWorktree(worktreePath)];
}

export function buildGrokArgs(prompt, worktreePath) {
  const args = [
    "-p",
    prompt,
    "--output-format",
    "json",
    "--max-turns",
    "40",
    "--always-approve",
    "--sandbox",
    SANDBOX_PROFILE,
  ];
  for (const rule of grokDenyRules(worktreePath)) {
    args.push("--deny", rule);
  }
  return args;
}

const AUTH_CAP = 2 * 1024 * 1024;

function readNoFollow(source, maxBytes) {
  let info;
  try {
    info = fs.lstatSync(source);
  } catch {
    return null;
  }
  if (!info.isFile() || info.isSymbolicLink()) return null;
  const input = fs.openSync(source, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const chunks = [];
    const buffer = Buffer.alloc(64 * 1024);
    let position = 0;
    while (position <= maxBytes) {
      const read = fs.readSync(input, buffer, 0, buffer.length, position);
      if (read <= 0) break;
      chunks.push(Buffer.from(buffer.subarray(0, read)));
      position += read;
      if (position > maxBytes) return null;
    }
    return Buffer.concat(chunks, position);
  } finally {
    fs.closeSync(input);
  }
}

function writeNoFollow(dest, bytes) {
  const output = fs.openSync(
    dest,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
    0o444,
  );
  try {
    fs.writeSync(output, bytes);
  } catch (error) {
    try {
      fs.closeSync(output);
    } catch {
      // The destination fd is already closed.
    }
    try {
      fs.unlinkSync(dest);
    } catch {
      // The partial copy is already gone.
    }
    throw error;
  }
  fs.closeSync(output);
  fs.chmodSync(dest, 0o444);
}

export function copyGrokAuth(source, dest) {
  const bytes = readNoFollow(source, AUTH_CAP);
  if (!bytes) return false;
  writeNoFollow(dest, bytes);
  return true;
}

export function prepareAgentSandbox(realHome = os.homedir()) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "feedback-board-agent-"));
  const home = path.join(root, "home");
  const tmp = path.join(root, "tmp");
  const grokHome = path.join(home, ".grok");
  fs.mkdirSync(tmp, { recursive: true, mode: 0o700 });
  fs.mkdirSync(grokHome, { recursive: true, mode: 0o755 });
  const authBytes = readNoFollow(path.join(realHome, ".grok", "auth.json"), AUTH_CAP);
  if (authBytes) writeNoFollow(path.join(grokHome, "auth.json"), authBytes);
  return { root, home, tmp, grokHome, authCopied: Boolean(authBytes), authBytes: authBytes || null };
}

const AGENT_ENV_EXACT = new Set(["PATH", "LANG", "TERM", "TZ", "USER", "SHELL"]);
const SECRET_ENV_NAME = /(TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL)S?$|^AWS_/i;

export function isAllowedAgentEnvKey(key) {
  return AGENT_ENV_EXACT.has(key) || String(key).startsWith("LC_");
}

export function droppedCredentialValues(source = process.env) {
  const values = [];
  for (const [key, value] of Object.entries(source || {})) {
    if (isAllowedAgentEnvKey(key)) continue;
    if (typeof value !== "string" || value.length < 20) continue;
    if (!SECRET_ENV_NAME.test(key)) continue;
    values.push(value);
  }
  return values;
}

export function scrubAgentEnv(source = process.env, options = {}) {
  const env = {};
  for (const [key, value] of Object.entries(source || {})) {
    if (!isAllowedAgentEnvKey(key)) continue;
    if (typeof value === "string") env[key] = value;
  }
  const sandbox = options.home ? null : prepareAgentSandbox(options.realHome);
  const home = options.home || sandbox.home;
  const tmp = options.tmp || sandbox.tmp;
  fs.mkdirSync(path.join(home, ".grok"), { recursive: true });
  fs.mkdirSync(tmp, { recursive: true });
  env.HOME = home;
  env.TMPDIR = tmp;
  env.GROK_HOME = path.join(home, ".grok");
  if (options.marker) env[RUN_MARKER_ENV] = options.marker;
  return env;
}

export function agentSpawnPlan(command, args, platform = process.platform) {
  if (platform === "linux") {
    return {
      command: "unshare",
      args: [
        "--user",
        "--map-root-user",
        "--pid",
        "--fork",
        "--kill-child",
        "--mount-proc",
        "--",
        command,
        ...args,
      ],
      contained: true,
    };
  }
  return { command, args, contained: false };
}

export function spawnGrok({ command, prompt, worktreePath, env, contain = false }) {
  const grokArgs = buildGrokArgs(prompt, worktreePath);
  const plan = contain ? agentSpawnPlan(command, grokArgs) : { command, args: grokArgs };
  return spawn(plan.command, plan.args, {
    cwd: worktreePath,
    shell: false,
    env,
    detached: true,
  });
}

export function killProcessGroup(child, signal) {
  if (child && Number.isInteger(child.pid)) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // The process group is already gone.
    }
  }
  if (child && child.exitCode === null && child.signalCode === null) {
    try {
      child.kill(signal);
    } catch {
      // The process is already gone.
    }
  }
}

export function groupAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if (error && error.code === "ESRCH") return false;
    return true;
  }
}

export async function reapAgentGroup(pid, waitMs = 3000) {
  if (!Number.isInteger(pid) || pid <= 0) return { ok: true };
  try {
    process.kill(-pid, "SIGKILL");
  } catch (error) {
    if (!error || error.code !== "ESRCH") {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already gone, or not our process.
      }
    }
  }
  const started = Date.now();
  while (Date.now() - started < waitMs) {
    if (!groupAlive(pid)) return { ok: true };
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  if (!groupAlive(pid)) return { ok: true };
  return { ok: false, reason: "Agent processes are still running." };
}

function globToRegExp(pattern) {
  let source = "^";
  for (const char of pattern) {
    if (char === "*") source += ".*";
    else if (char === "?") source += ".";
    else source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  source += "$";
  return new RegExp(source);
}

export function bashDenyMatches(rule, command) {
  const wrapped = String(rule).match(/^Bash\((.*)\)$/);
  if (!wrapped) return false;
  const pattern = wrapped[1];
  const whole = String(command).trim();
  const segments = whole
    .split(/&&|\|\||;|\||\n/)
    .map((part) => part.trim())
    .filter(Boolean);
  const matcher = globToRegExp(pattern);
  return [whole, ...segments].some((text) => matcher.test(text));
}

export function commandDeniedByRules(rules, command) {
  return rules.some((rule) => bashDenyMatches(rule, command));
}

export function shortCardId(cardId) {
  const compact = String(cardId).replace(/-/g, "");
  return compact.slice(0, 8);
}

export function pullRequestText(cardId, files) {
  const title = `feedback: card ${shortCardId(cardId)}`;
  const lines = (files || [])
    .map((file) => String(file).trim())
    .filter((file) => file && !/[\r\n]/.test(file));
  const body = [
    "Changed files:",
    ...(lines.length ? lines.map((file) => `- ${file}`) : ["- (none)"]),
    "",
    "Run summary: draft opened by the local feedback board. The pull request is not merged.",
  ].join("\n");
  return { title, body, message: title };
}

export const DEFAULT_GIT_NAME = "feedback-board";
export const DEFAULT_GIT_EMAIL = "feedback-board@localhost";
export const GH_CREDENTIAL_HELPER = "!gh auth git-credential";

export function boardGitEnv(base = {}) {
  return {
    ...base,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
  };
}

export function publishConfigArgs() {
  return [
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "credential.helper=",
    "-c",
    `credential.https://github.com.helper=${GH_CREDENTIAL_HELPER}`,
  ];
}

function identityValue(value, fallback) {
  const text = String(value ?? "").replace(/\r?\n/g, "").trim();
  return text || fallback;
}

export function commitArgs(message, identity = {}) {
  const name = identityValue(identity.name, DEFAULT_GIT_NAME);
  const email = identityValue(identity.email, DEFAULT_GIT_EMAIL);
  return [
    ...publishConfigArgs(),
    "-c",
    `user.name=${name}`,
    "-c",
    `user.email=${email}`,
    "commit",
    "-m",
    message,
  ];
}

export function pushArgs(finalSha, branch) {
  if (!/^[0-9a-f]{40}$/i.test(finalSha)) throw new Error("finalSha is not pinned.");
  if (!/^feedback\/card-[0-9a-f-]{36}$/i.test(branch)) throw new Error("branch is not a card branch.");
  return [...publishConfigArgs(), "push", PUSH_URL, `${finalSha}:refs/heads/${branch}`];
}
