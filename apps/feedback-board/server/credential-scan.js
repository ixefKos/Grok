export const CREDENTIAL_RUN_STATUS = "credential_refused";

const MIN_SECRET = 20;
const SECRET_KEY = /token|key|secret|password|credential/i;
const TOKEN_PATTERN =
  /(?<![A-Za-z0-9])(?:xai-[A-Za-z0-9]{20,}|gh[pos]_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{22,}|AKIA[0-9A-Z]{16})|(?<![A-Za-z0-9_-])sk-[A-Za-z0-9_-]{20,}/;
const PRIVATE_KEY = /-----BEGIN (?:[A-Z0-9]+ ){0,3}PRIVATE KEY(?: BLOCK)?-----/;

const TOKEN_NAMES = [
  ["xai-", "xai-"],
  ["github_pat_", "github_pat_"],
  ["ghp_", "ghp_"],
  ["gho_", "gho_"],
  ["ghs_", "ghs_"],
  ["sk-", "sk-"],
  ["AKIA", "AKIA"],
];

function addNeedle(needles, seen, value) {
  const buf = Buffer.isBuffer(value) ? value : Buffer.from(String(value), "utf8");
  if (buf.length < MIN_SECRET) return;
  const key = buf.toString("latin1");
  if (seen.has(key)) return;
  seen.add(key);
  needles.push(buf);
}

function base64Forms(token) {
  const forms = [];
  for (let align = 0; align <= 2; align += 1) {
    const combined = Buffer.concat([Buffer.alloc(align), token]);
    const encoded = combined.toString("base64");
    const first = Math.ceil(align / 3);
    const last = Math.floor((align + token.length) / 3);
    if (last <= first) continue;
    const slice = encoded.slice(first * 4, last * 4);
    if (slice.length < MIN_SECRET) continue;
    forms.push(slice);
    const url = slice.replaceAll("+", "-").replaceAll("/", "_");
    if (url !== slice) forms.push(url);
  }
  return forms;
}

function rememberSecret(needles, seen, value) {
  const token = Buffer.from(String(value), "utf8");
  addNeedle(needles, seen, token);
  for (const form of base64Forms(token)) addNeedle(needles, seen, form);
}

function collectSecrets(value, keyName, needles, seen, depth, inherited) {
  if (depth > 20) return;
  const secretHere = Boolean(inherited) || isSecretKey(keyName);
  if (typeof value === "string") {
    if (secretHere && value.length >= MIN_SECRET) rememberSecret(needles, seen, value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectSecrets(item, keyName, needles, seen, depth + 1, secretHere);
    return;
  }
  if (value && typeof value === "object") {
    for (const [childKey, child] of Object.entries(value)) {
      collectSecrets(child, childKey, needles, seen, depth + 1, secretHere);
    }
  }
}

function isSecretKey(name) {
  return SECRET_KEY.test(String(name || ""));
}

export function authNeedles(authBytes) {
  const needles = [];
  const seen = new Set();
  if (!authBytes) return needles;
  const raw = Buffer.isBuffer(authBytes) ? authBytes : Buffer.from(String(authBytes));
  const text = raw.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(raw)) return needles;
  try {
    collectSecrets(JSON.parse(text), "", needles, seen, 0, false);
  } catch {
    // Auth that is not JSON contributes no substring needles.
  }
  return needles;
}

function asBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (typeof value === "string") return Buffer.from(value);
  return Buffer.alloc(0);
}

function patternName(text) {
  if (PRIVATE_KEY.test(text)) return "private-key";
  const match = TOKEN_PATTERN.exec(text);
  if (!match) return null;
  const found = match[0];
  for (const [prefix, name] of TOKEN_NAMES) {
    if (found.startsWith(prefix)) return name;
  }
  return null;
}

function classify(bytes, needles) {
  const kind = patternName(bytes.toString("latin1"));
  if (kind) return kind;
  for (const needle of needles) {
    if (needle.length >= MIN_SECRET && bytes.includes(needle)) return "auth-token";
  }
  return null;
}

export function scanPublishChanges(changes, authBytes, envSecrets) {
  const needles = authNeedles(authBytes);
  const seen = new Set(needles.map((needle) => needle.toString("latin1")));
  for (const value of envSecrets || []) {
    if (typeof value === "string") rememberSecret(needles, seen, value);
  }
  const hits = [];
  const list = changes || [];
  for (let index = 0; index < list.length; index += 1) {
    const change = list[index];
    if (!change || typeof change.path !== "string") continue;
    const pathKind = classify(Buffer.from(change.path), needles);
    const contentKind = change.kind !== "delete" && change.bytes ? classify(asBuffer(change.bytes), needles) : null;
    const pattern = contentKind || pathKind;
    if (!pattern) continue;
    hits.push({ pattern, index });
  }
  if (!hits.length) return { ok: true, blocked: [] };
  const listed = hits.map((hit) => `${hit.pattern} at file ${hit.index}`).join(", ");
  return {
    ok: false,
    reason: `A file to be published contains a credential (${listed}).`,
    pattern: hits[0].pattern,
    index: hits[0].index,
    hits,
    runStatus: CREDENTIAL_RUN_STATUS,
    blocked: [],
  };
}
