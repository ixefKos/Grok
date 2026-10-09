import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

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

export function scrubAgentEnv(source = process.env) {
  const env = {};
  for (const [key, value] of Object.entries(source)) {
    if (key === "GH_TOKEN" || key === "GITHUB_TOKEN" || key.startsWith("GH_")) continue;
    if (key === "GIT_ASKPASS" || key === "SSH_AUTH_SOCK") continue;
    if (typeof value === "string") env[key] = value;
  }
  env.GH_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "feedback-board-gh-"));
  env.GIT_TERMINAL_PROMPT = "0";
  return env;
}

export function spawnGrok({ command, prompt, worktreePath, env }) {
  return spawn(command, buildGrokArgs(prompt, worktreePath), {
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
