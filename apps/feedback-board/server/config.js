import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULTS = {
  inboxRepo: "ixefKos/feedback-inbox",
  agentsEnabled: false,
  dailyCap: 3,
  workCopyPath: "",
  grokCommand: "grok",
  port: 4173,
};

const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export function appRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

export function normalizeConfig(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  const inboxRepo =
    typeof source.inboxRepo === "string" && REPO_PATTERN.test(source.inboxRepo)
      ? source.inboxRepo
      : DEFAULTS.inboxRepo;
  const dailyCap =
    Number.isInteger(source.dailyCap) && source.dailyCap >= 0
      ? source.dailyCap
      : DEFAULTS.dailyCap;
  const port =
    Number.isInteger(source.port) && source.port >= 1 && source.port <= 65535
      ? source.port
      : DEFAULTS.port;
  const workCopyPath = typeof source.workCopyPath === "string" ? source.workCopyPath : "";
  let grokCommand =
    typeof source.grokCommand === "string" ? source.grokCommand.trim() : DEFAULTS.grokCommand;
  if (!grokCommand || /[\r\n\0]/.test(grokCommand)) grokCommand = DEFAULTS.grokCommand;
  return {
    inboxRepo,
    agentsEnabled: source.agentsEnabled === true,
    dailyCap,
    workCopyPath,
    grokCommand,
    port,
  };
}

export function loadConfig(root = appRoot()) {
  const examplePath = path.join(root, "config.example.json");
  const localPath = path.join(root, "config.local.json");
  const example = fs.existsSync(examplePath) ? readJson(examplePath) : {};
  const local = fs.existsSync(localPath) ? readJson(localPath) : {};
  return normalizeConfig({ ...DEFAULTS, ...example, ...local });
}
