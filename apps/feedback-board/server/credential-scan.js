export const CREDENTIAL_REASON = "A file to be published contains a credential.";

const MIN_NEEDLE = 8;

const PATTERNS = [
  /xai-/,
  /ghp_/,
  /gho_/,
  /ghs_/,
  /github_pat_/,
  /sk-/,
  /AKIA/,
  /-----BEGIN .* PRIVATE KEY-----/,
];

function remember(needles, seen, value) {
  const buf = Buffer.isBuffer(value) ? value : Buffer.from(String(value), "utf8");
  if (buf.length < MIN_NEEDLE) return;
  const key = buf.toString("latin1");
  if (seen.has(key)) return;
  seen.add(key);
  needles.push(buf);
  const encoded = Buffer.from(buf.toString("base64"), "utf8");
  const encodedKey = encoded.toString("latin1");
  if (encoded.length < MIN_NEEDLE || seen.has(encodedKey)) return;
  seen.add(encodedKey);
  needles.push(encoded);
}

function collectStrings(value, needles, seen, depth) {
  if (depth > 20) return;
  if (typeof value === "string") {
    remember(needles, seen, value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, needles, seen, depth + 1);
    return;
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) collectStrings(item, needles, seen, depth + 1);
  }
}

export function authNeedles(authBytes) {
  const needles = [];
  const seen = new Set();
  if (!authBytes) return needles;
  const raw = Buffer.isBuffer(authBytes) ? authBytes : Buffer.from(String(authBytes));
  remember(needles, seen, raw);
  const text = raw.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(raw)) return needles;
  const trimmed = text.trim();
  if (trimmed && trimmed !== text) remember(needles, seen, trimmed);
  try {
    collectStrings(JSON.parse(text), needles, seen, 0);
  } catch {
    // The auth file is not JSON. The raw bytes are already a needle.
  }
  return needles;
}

function asBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (typeof value === "string") return Buffer.from(value);
  return Buffer.alloc(0);
}

function hits(bytes, needles) {
  for (const needle of needles) {
    if (needle.length >= MIN_NEEDLE && bytes.includes(needle)) return true;
  }
  const text = bytes.toString("latin1");
  return PATTERNS.some((pattern) => pattern.test(text));
}

export function scanPublishChanges(changes, authBytes) {
  const needles = authNeedles(authBytes);
  const blocked = [];
  let found = false;
  for (const change of changes || []) {
    if (!change || typeof change.path !== "string") continue;
    const pathHit = hits(Buffer.from(change.path), needles);
    const contentHit = change.kind !== "delete" && change.bytes ? hits(asBuffer(change.bytes), needles) : false;
    if (!pathHit && !contentHit) continue;
    found = true;
    if (!pathHit) blocked.push(change.path);
  }
  if (!found) return { ok: true, blocked: [] };
  return { ok: false, reason: CREDENTIAL_REASON, blocked };
}
