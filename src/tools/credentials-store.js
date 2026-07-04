// Shared, side-effect-free store for user-managed credentials — the free-form
// secrets/logins that DON'T have a dedicated plugin or MCP server (a server login,
// an API key for some one-off service, etc.). Both the config-UI server (CRUD tab)
// and the bot (via the get_credentials tool, see credentials.js) import this.
//
// Model: each entry is { name, description, fields[], notes }. A `field` is a
// labelled part — { label, value, secret } — so a login is two fields (username +
// a secret password), an API key is one secret field, a DB cred is host/user/pass/
// port, etc. There is no special "primary value"; any field can be marked secret,
// and secret values are only sent to the browser on an explicit reveal (masked in
// the list). Storage: a single JSON list at AIROUTER_HOME/credentials/credentials.json
// (chmod 600). On first use it migrates the legacy free-text credentials.md, and it
// transparently upgrades older JSON entries (the old value + {key,value} shape).
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from "fs";
import { join } from "path";
import { randomUUID } from "crypto";
import { CREDENTIALS_DIR } from "../config/paths.js";

const STORE_FILE = join(CREDENTIALS_DIR, "credentials.json");
const LEGACY_MD = join(CREDENTIALS_DIR, "credentials.md");
const nowIso = () => new Date().toISOString();

// Labels that should default to "secret" (hidden) when auto-detected/migrated.
const SECRET_KEY = /^(pass(word|wd)?|secret|token|api[_-]?key|key|pat|auth|bearer|private[_-]?key|client[_-]?secret)$/i;
const USER_KEY = /^(user(name)?|login|email|account)$/i;

function ensureDir() { try { mkdirSync(CREDENTIALS_DIR, { recursive: true }); } catch { /* ignore */ } }
function readRaw() {
  if (!existsSync(STORE_FILE)) return null; // null => migrate
  try { const a = JSON.parse(readFileSync(STORE_FILE, "utf8")); return Array.isArray(a) ? a : []; } catch { return []; }
}
function writeRaw(list) {
  ensureDir();
  try { writeFileSync(STORE_FILE, JSON.stringify(list, null, 2), "utf8"); chmodSync(STORE_FILE, 0o600); }
  catch (e) { console.error("[credentials] write failed: " + e.message); }
}

// A field is { label, value, secret }. Accepts the old { key, value } shape too.
function cleanFields(fields) {
  if (!Array.isArray(fields)) return [];
  return fields
    .map((f) => {
      if (!f) return null;
      const label = String(f.label != null ? f.label : (f.key != null ? f.key : "")).trim();
      const value = String(f.value != null ? f.value : "");
      const secret = f.secret != null ? !!f.secret : SECRET_KEY.test(label);
      return { label, value, secret };
    })
    .filter((f) => f && (f.label || f.value));
}

// Split a free-text block into { fields[], notes }. A "field" line is a short
// label followed by : or = and a value (user: root, port=8006). Other lines
// (prose, URLs, headings) stay in notes.
function parseBody(text) {
  const fields = [];
  const noteLines = [];
  for (const raw of String(text || "").split("\n")) {
    const line = raw.replace(/\s+$/, "");
    const m = /^\s*[-*]?\s*([A-Za-z][A-Za-z0-9_.\-]{0,28})\s*[:=]\s*(\S.*)$/.exec(line);
    const key = m ? m[1].trim() : "";
    if (m && !/^#{1,6}\s/.test(line) && !/^https?$/i.test(key) && !m[2].startsWith("//")) {
      fields.push({ label: key, value: m[2].trim(), secret: SECRET_KEY.test(key) });
    } else {
      noteLines.push(line);
    }
  }
  return { fields, notes: noteLines.join("\n").replace(/^\s+|\s+$/g, "") };
}

function mkEntry(input) {
  return {
    id: randomUUID(),
    name: (input.name || "Untitled").trim(),
    description: (input.description || "").trim(),
    fields: cleanFields(input.fields),
    notes: input.notes || "",
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
}

// --- legacy credentials.md migration (grouped by "## Heading" sections) ---
function entryFromSection(name, body) {
  const { fields, notes } = parseBody(body);
  return { ...mkEntry({ name, notes }), fields };
}
function parseMarkdownSections(md) {
  const out = [];
  let cur = null;
  for (const line of md.split("\n")) {
    const m = /^##\s+(?!#)(.+?)\s*$/.exec(line);
    if (m) { if (cur) out.push(cur); cur = { name: m[1].trim(), body: [] }; }
    else if (cur) cur.body.push(line);
  }
  if (cur) out.push(cur);
  return out
    .filter((e) => e.name.toLowerCase() !== "format" && !/^\[.*\]$/.test(e.name))
    .map((e) => ({ name: e.name, body: e.body.join("\n") }));
}

// Bring older JSON entries up to the current shape in place: convert {key,value}
// fields, promote the old primary `value` into a secret field, drop `value`.
function normalize(c) {
  let changed = false;
  if (!Array.isArray(c.fields)) { c.fields = []; changed = true; }
  const before = JSON.stringify(c.fields);
  c.fields = cleanFields(c.fields);
  if (JSON.stringify(c.fields) !== before) changed = true;
  if (typeof c.value === "string" && c.value) {
    const hasUser = c.fields.some((f) => USER_KEY.test(f.label));
    c.fields.unshift({ label: hasUser ? "password" : "secret", value: c.value, secret: true });
    changed = true;
  }
  if ("value" in c) { delete c.value; changed = true; }
  if (typeof c.description !== "string") { c.description = ""; changed = true; }
  return changed;
}

function all() {
  let list = readRaw();
  if (list === null) {
    list = [];
    if (existsSync(LEGACY_MD)) {
      try { list = parseMarkdownSections(readFileSync(LEGACY_MD, "utf8")).map((s) => entryFromSection(s.name, s.body)); }
      catch (e) { console.error("[credentials] migrate failed: " + e.message); }
    }
    writeRaw(list);
    return list;
  }
  let changed = false;
  for (const c of list) if (normalize(c)) changed = true;
  if (changed) writeRaw(list);
  return list;
}

// -------------------------------------------------------------- CRUD ---------
// The list masks secret values (only whether one is set) — reveal fetches them.
export function listCredentials() {
  return all().map((c) => ({
    id: c.id, name: c.name, description: c.description || "",
    fields: cleanFields(c.fields).map((f) => ({ label: f.label, secret: f.secret, hasValue: !!f.value, value: f.secret ? "" : f.value })),
    notes: c.notes || "", createdAt: c.createdAt, updatedAt: c.updatedAt,
  }));
}
// Full values for one entry — used by the reveal endpoint (auth + CSRF) and the editor.
export function revealCredential(id) {
  const c = all().find((x) => x.id === id);
  if (!c) return null;
  return { id: c.id, name: c.name, description: c.description || "", fields: cleanFields(c.fields), notes: c.notes || "" };
}
export function getCredential(id) { return all().find((c) => c.id === id) || null; }

export function createCredential(input) {
  const list = all(); const entry = mkEntry(input || {}); list.push(entry); writeRaw(list);
  return { id: entry.id, name: entry.name };
}
export function updateCredential(id, patch) {
  const list = all(); const c = list.find((x) => x.id === id); if (!c) return null;
  if ("name" in patch) c.name = (patch.name || "Untitled").trim();
  if ("description" in patch) c.description = (patch.description || "").trim();
  if ("fields" in patch) c.fields = cleanFields(patch.fields);
  if ("notes" in patch) c.notes = patch.notes || "";
  c.updatedAt = nowIso(); writeRaw(list);
  return { id: c.id, name: c.name };
}
export function deleteCredential(id) {
  const list = all(); const i = list.findIndex((x) => x.id === id); if (i < 0) return false;
  list.splice(i, 1); writeRaw(list); return true;
}
export function duplicateCredential(id) {
  const list = all(); const c = list.find((x) => x.id === id); if (!c) return null;
  const copy = { ...c, id: randomUUID(), name: c.name + " (copy)", fields: cleanFields(c.fields), createdAt: nowIso(), updatedAt: nowIso() };
  list.push(copy); writeRaw(list); return { id: copy.id, name: copy.name };
}

// ------------------------------------------------- lookup for the bot tool ---
// Returns full markdown (with values) for matching credentials — the get_credentials
// tool is owner-only, so the bot gets the real secrets it needs to use them.
function fmt(c) {
  const parts = ["## " + c.name];
  if (c.description) parts.push(c.description);
  for (const f of cleanFields(c.fields)) parts.push(f.label + ": " + f.value);
  if (c.notes) parts.push("\n" + c.notes);
  return parts.join("\n").trim();
}
// Exact values of all SECRET fields (+ any legacy primary value), longest first,
// cached 30s. Used by the Discord output filter to redact stored secrets verbatim
// (precise, no false positives) on top of the pattern-based redaction.
let _redactCache = { at: 0, values: [] };
export function getRedactionValues() {
  const now = Date.now();
  if (now - _redactCache.at < 30000) return _redactCache.values;
  const list = readRaw() || [];
  const vals = [];
  for (const c of list) {
    if (typeof c.value === "string" && c.value.length >= 3) vals.push(c.value); // legacy primary value
    for (const f of cleanFields(c.fields)) if (f.secret && f.value && f.value.length >= 3) vals.push(f.value);
  }
  _redactCache = { at: now, values: [...new Set(vals)].sort((a, b) => b.length - a.length) };
  return _redactCache.values;
}

export function lookupCredentials(service) {
  const entries = all();
  const q = (service || "").trim().toLowerCase();
  if (!q) return entries.length ? entries.map(fmt).join("\n\n") : "No credentials stored.";
  const hay = (c) => [c.name, c.description, c.notes, ...cleanFields(c.fields).flatMap((f) => [f.label, f.value])].join("\n").toLowerCase();
  const hits = entries.filter((c) => hay(c).includes(q));
  return hits.length ? hits.map(fmt).join("\n\n") : "No credentials found for \"" + service + "\"";
}
