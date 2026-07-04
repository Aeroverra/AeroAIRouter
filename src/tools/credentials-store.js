// Shared, side-effect-free store for user-managed credentials — the free-form
// secrets/logins that DON'T have a dedicated plugin or MCP server (a server login,
// an API key for some one-off service, etc.). Both the config-UI server (CRUD tab)
// and the bot (via the get_credentials tool, see credentials.js) import this.
//
// Each entry has a primary `value` (the secret you copy most), optional extra
// `fields` (key/value pairs — user, host, port…), a one-line `description`, and
// free-text `notes` (how to use it). Storage is a single JSON list at
// AIROUTER_HOME/credentials/credentials.json, chmod 600. On first use it migrates
// the legacy free-text credentials.md (grouped by "## Heading" sections), splitting
// each section's "key: value" lines into fields and promoting the obvious secret to
// the primary value; prose becomes notes.
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from "fs";
import { join } from "path";
import { randomUUID } from "crypto";
import { CREDENTIALS_DIR } from "../config/paths.js";

const STORE_FILE = join(CREDENTIALS_DIR, "credentials.json");
const LEGACY_MD = join(CREDENTIALS_DIR, "credentials.md");

const nowIso = () => new Date().toISOString();

function ensureDir() { try { mkdirSync(CREDENTIALS_DIR, { recursive: true }); } catch { /* ignore */ } }

// null = no store file yet (triggers migration); [] = present but empty/corrupt.
function readRaw() {
  if (!existsSync(STORE_FILE)) return null;
  try { const a = JSON.parse(readFileSync(STORE_FILE, "utf8")); return Array.isArray(a) ? a : []; }
  catch { return []; }
}
function writeRaw(list) {
  ensureDir();
  try { writeFileSync(STORE_FILE, JSON.stringify(list, null, 2), "utf8"); chmodSync(STORE_FILE, 0o600); }
  catch (e) { console.error("[credentials] write failed: " + e.message); }
}

// Split a free-text block into { value, fields[], notes }.
// A "field" line is a short single-token label followed by : or = and a value
// (user: root, port=8006). Lines that don't fit — prose, URLs, headings — stay in
// notes. The first field that looks like the actual secret is promoted to `value`.
const SECRET_KEY = /^(pass(word|wd)?|secret|token|api[_-]?key|key|pat|auth|bearer)$/i;
function parseBody(text) {
  const fields = [];
  const noteLines = [];
  for (const raw of String(text || "").split("\n")) {
    const line = raw.replace(/\s+$/, "");
    const m = /^\s*[-*]?\s*([A-Za-z][A-Za-z0-9_.\-]{0,28})\s*[:=]\s*(\S.*)$/.exec(line);
    const key = m ? m[1].trim() : "";
    if (m && !/^#{1,6}\s/.test(line) && !/^https?$/i.test(key) && !m[2].startsWith("//")) {
      fields.push({ key, value: m[2].trim() });
    } else {
      noteLines.push(line);
    }
  }
  let value = "";
  const pi = fields.findIndex((f) => SECRET_KEY.test(f.key));
  if (pi >= 0) { value = fields[pi].value; fields.splice(pi, 1); }
  const notes = noteLines.join("\n").replace(/^\s+|\s+$/g, "");
  return { value, fields, notes };
}

function cleanFields(fields) {
  if (!Array.isArray(fields)) return [];
  return fields
    .filter((f) => f && (String(f.key || "").trim() || String(f.value || "").trim()))
    .map((f) => ({ key: String(f.key || "").trim(), value: String(f.value || "") }));
}

function mkEntry(input) {
  return {
    id: randomUUID(),
    name: (input.name || "Untitled").trim(),
    description: (input.description || "").trim(),
    value: input.value || "",
    fields: cleanFields(input.fields),
    notes: input.notes || "",
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
}

// Create an entry from a legacy "## Section" (name + free-text body).
function entryFromSection(name, body) {
  const { value, fields, notes } = parseBody(body);
  return { ...mkEntry({ name, value, notes }), fields };
}

// Split a legacy credentials.md into { name, body } per top-level "## " section.
function parseMarkdownSections(md) {
  const out = [];
  let cur = null;
  for (const line of md.split("\n")) {
    const m = /^##\s+(?!#)(.+?)\s*$/.exec(line); // "## X" but not "### X"
    if (m) {
      if (cur) out.push(cur);
      cur = { name: m[1].trim(), body: [] };
    } else if (cur) {
      cur.body.push(line);
    }
  }
  if (cur) out.push(cur);
  return out
    .filter((e) => e.name.toLowerCase() !== "format" && !/^\[.*\]$/.test(e.name)) // drop doc's Format + [placeholder]
    .map((e) => ({ name: e.name, body: e.body.join("\n") }));
}

// Bring older-schema entries (pre-fields) up to date in place: if an entry has no
// `fields` array, re-parse its notes into value/fields/notes.
function upgrade(list) {
  let changed = false;
  for (const c of list) {
    if (!Array.isArray(c.fields)) {
      const parsed = parseBody(c.notes || "");
      c.value = c.value || parsed.value;
      c.fields = parsed.fields;
      c.notes = parsed.notes;
      if (typeof c.description !== "string") c.description = "";
      changed = true;
    }
  }
  return changed;
}

// Create the JSON store on first use (seed from legacy md), then keep it upgraded.
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
  if (upgrade(list)) writeRaw(list);
  return list;
}

// ---------------------------------------------------------------- CRUD -------
export function listCredentials() {
  // Admin-only UI: return values so the tab can reveal/copy them.
  return all().map((c) => ({
    id: c.id, name: c.name, description: c.description || "", value: c.value || "",
    fields: cleanFields(c.fields), notes: c.notes || "", createdAt: c.createdAt, updatedAt: c.updatedAt,
  }));
}
export function getCredential(id) { return all().find((c) => c.id === id) || null; }

export function createCredential(input) {
  const list = all();
  const entry = mkEntry(input || {});
  list.push(entry); writeRaw(list); return entry;
}
export function updateCredential(id, patch) {
  const list = all(); const c = list.find((x) => x.id === id); if (!c) return null;
  if ("name" in patch) c.name = (patch.name || "Untitled").trim();
  if ("description" in patch) c.description = (patch.description || "").trim();
  if ("value" in patch) c.value = patch.value || "";
  if ("fields" in patch) c.fields = cleanFields(patch.fields);
  if ("notes" in patch) c.notes = patch.notes || "";
  c.updatedAt = nowIso(); writeRaw(list); return c;
}
export function deleteCredential(id) {
  const list = all(); const i = list.findIndex((x) => x.id === id); if (i < 0) return false;
  list.splice(i, 1); writeRaw(list); return true;
}
export function duplicateCredential(id) {
  const list = all(); const c = list.find((x) => x.id === id); if (!c) return null;
  const copy = { ...c, id: randomUUID(), name: c.name + " (copy)", fields: cleanFields(c.fields), createdAt: nowIso(), updatedAt: nowIso() };
  list.push(copy); writeRaw(list); return copy;
}

// ------------------------------------------------- lookup for the bot tool ---
// Returns a formatted markdown string of matching credentials (or all when no
// service is given). Used by the get_credentials tool.
function fmt(c) {
  const parts = [`## ${c.name}`];
  if (c.description) parts.push(c.description);
  if (c.value) parts.push("value: " + c.value);
  for (const f of cleanFields(c.fields)) parts.push(f.key + ": " + f.value);
  if (c.notes) parts.push("\n" + c.notes);
  return parts.join("\n").trim();
}
export function lookupCredentials(service) {
  const entries = all();
  const q = (service || "").trim().toLowerCase();
  if (!q) return entries.length ? entries.map(fmt).join("\n\n") : "No credentials stored.";
  const hay = (c) => [c.name, c.description, c.value, c.notes, ...cleanFields(c.fields).flatMap((f) => [f.key, f.value])].join("\n").toLowerCase();
  const hits = entries.filter((c) => hay(c).includes(q));
  return hits.length ? hits.map(fmt).join("\n\n") : `No credentials found for "${service}"`;
}
