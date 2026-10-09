import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const AGENT_BUSY = "A process is still using the agent tree.";

function isInside(root, value) {
  if (!value) return false;
  const base = path.resolve(root);
  let target = String(value);
  if (target.endsWith(" (deleted)")) target = target.slice(0, -" (deleted)".length);
  if (!path.isAbsolute(target)) return false;
  const resolved = path.resolve(target);
  return resolved === base || resolved.startsWith(`${base}${path.sep}`);
}

function linuxUsers(root) {
  const hits = [];
  let entries;
  try {
    entries = fs.readdirSync("/proc");
  } catch {
    return { ok: false, reason: AGENT_BUSY, blocked: [] };
  }
  for (const entry of entries) {
    if (!/^[1-9]\d*$/.test(entry)) continue;
    const pid = Number(entry);
    if (pid === process.pid) continue;
    const cwd = readLink(path.join("/proc", entry, "cwd"));
    if (isInside(root, cwd)) {
      hits.push(String(pid));
      continue;
    }
    let fds;
    try {
      fds = fs.readdirSync(path.join("/proc", entry, "fd"));
    } catch {
      continue;
    }
    for (const fd of fds) {
      const target = readLink(path.join("/proc", entry, "fd", fd));
      if (!target || target.startsWith("socket:") || target.startsWith("pipe:") || target.startsWith("anon_inode:")) {
        continue;
      }
      if (isInside(root, target)) {
        hits.push(String(pid));
        break;
      }
    }
  }
  if (hits.length) return { ok: false, reason: AGENT_BUSY, blocked: hits };
  return { ok: true, blocked: [] };
}

function readLink(file) {
  try {
    return fs.readlinkSync(file);
  } catch {
    return null;
  }
}

export const LSOF_BIN = "/usr/sbin/lsof";
export const LSOF_MAX_BUFFER = 64 * 1024 * 1024;

export function interpretLsofOutput(stdout, root) {
  const hits = new Set();
  let pid = "";
  for (const line of String(stdout || "").split(/\n/)) {
    if (line.startsWith("p")) pid = line.slice(1).trim();
    else if (line.startsWith("n") && pid && isInside(root, line.slice(1))) hits.add(pid);
  }
  if (hits.size) return { ok: false, reason: AGENT_BUSY, blocked: [...hits] };
  return { ok: true, blocked: [] };
}

function runLsof(args, execImpl = execFileSync) {
  try {
    const stdout = execImpl(LSOF_BIN, args, {
      encoding: "utf8",
      timeout: 15000,
      maxBuffer: LSOF_MAX_BUFFER,
    });
    if (Buffer.byteLength(String(stdout)) >= LSOF_MAX_BUFFER) return { ok: false, stdout: "" };
    return { ok: true, stdout: String(stdout) };
  } catch {
    return { ok: false, stdout: "" };
  }
}

export function lsofUsers(root, execImpl = execFileSync) {
  const commands = [
    ["-nP", "-F", "pn"],
    ["-nP", "-a", "-d", "cwd", "-F", "pn"],
  ];
  const hits = new Set();
  for (const args of commands) {
    const ran = runLsof(args, execImpl);
    if (!ran.ok) return { ok: false, reason: AGENT_BUSY, blocked: [] };
    const parsed = interpretLsofOutput(ran.stdout, root);
    for (const pid of parsed.blocked || []) hits.add(pid);
  }
  if (hits.size) return { ok: false, reason: AGENT_BUSY, blocked: [...hits] };
  return { ok: true, blocked: [] };
}

export function agentTreeUsers(root) {
  if (process.platform === "linux") return linuxUsers(root);
  return lsofUsers(root);
}

export const RUN_MARKER_ENV = "FEEDBACK_BOARD_RUN";

export function pidsCarryingMarker(text, marker, selfPid = process.pid) {
  if (!marker) return [];
  const needle = `${RUN_MARKER_ENV}=${marker}`;
  const pids = [];
  for (const line of String(text || "").split(/\n/)) {
    if (!line.includes(needle)) continue;
    const match = line.match(/^\s*(\d+)\b/);
    if (!match) continue;
    const pid = Number(match[1]);
    if (pid > 1 && pid !== selfPid) pids.push(pid);
  }
  return pids;
}

export function killMarkedProcesses(marker, platform = process.platform) {
  if (platform !== "darwin") return { ok: true, killed: [] };
  if (!marker) return { ok: false, reason: AGENT_BUSY, killed: [] };
  let stdout = "";
  try {
    stdout = execFileSync("/bin/ps", ["-axEww", "-o", "pid=", "-o", "command="], {
      encoding: "utf8",
      timeout: 15000,
      maxBuffer: LSOF_MAX_BUFFER,
    });
  } catch {
    return { ok: false, reason: AGENT_BUSY, killed: [] };
  }
  const killed = [];
  for (const pid of pidsCarryingMarker(stdout, marker)) {
    try {
      process.kill(pid, "SIGKILL");
      killed.push(pid);
    } catch (error) {
      if (!error || error.code !== "ESRCH") return { ok: false, reason: AGENT_BUSY, killed };
    }
  }
  return { ok: true, killed };
}
