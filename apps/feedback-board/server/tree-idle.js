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

function lsofUsers(root) {
  const commands = [
    ["lsof", ["-nP", "-F", "pn"]],
    ["lsof", ["-nP", "-a", "-d", "cwd", "-F", "pn"]],
  ];
  const hits = new Set();
  for (const [command, args] of commands) {
    let stdout = "";
    try {
      stdout = execFileSync(command, args, {
        encoding: "utf8",
        timeout: 15000,
        maxBuffer: 64 * 1024 * 1024,
      });
    } catch (error) {
      stdout = error && error.stdout ? String(error.stdout) : "";
      if (!stdout && error && error.code === "ENOENT") {
        return { ok: false, reason: AGENT_BUSY, blocked: [] };
      }
      if (!stdout && error && !error.status) {
        return { ok: false, reason: AGENT_BUSY, blocked: [] };
      }
    }
    let pid = "";
    for (const line of String(stdout).split(/\n/)) {
      if (line.startsWith("p")) pid = line.slice(1).trim();
      else if (line.startsWith("n") && pid && isInside(root, line.slice(1))) hits.add(pid);
    }
  }
  if (hits.size) return { ok: false, reason: AGENT_BUSY, blocked: [...hits] };
  return { ok: true, blocked: [] };
}

export function agentTreeUsers(root) {
  if (process.platform === "linux") return linuxUsers(root);
  return lsofUsers(root);
}
