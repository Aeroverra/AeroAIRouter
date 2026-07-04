// Shared, side-effect-free store for user-managed credentials — the free-form
// secrets/logins that DON'T have a dedicated plugin or MCP server (a server login,
// an API key for some one-off service, etc.). Both the config-UI server (CRUD tab)
// and the bot (via the get_credentials tool, see credentials.js) import this.
//
// Storage is a single JSON list at AIROUTER_HOME/credentials/credentials.json,
// chmod 600. On first use it migrates the legacy free-text credentials.md (grouped
// by "## Heading" sections) into structured entries so nothing is lost.
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

// Split a legacy credentials.md into { name, notes } per top-level "## " section.
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
  // Drop the doc's own "## Format" instructions block; keep real entries.
  return out
    .filter((e) => e.name.toLowerCase() !== "format")
    .map((e) => ({ name: e.name, notes: e.body.join("\n").trim() }));
}

function mkEntry(input) {
  return {
    id: randomUUID(),
    name: (input.name || "Untitled").trim(),
    value: input.value || "",
    notes: input.notes || "",
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
}

// Create the JSON store on first use, seeding it from the legacy markdown if present.
function migrateOnce() {
  if (readRaw() !== null) return;
  let list = [];
  if (existsSync(LEGACY_MD)) {
    try { list = parseMarkdownSections(readFileSync(LEGACY_MD, "utf8")).map(mkEntry); }
    catch (e) { console.error("[credentials] migrate failed: " + e.message); }
  }
  writeRaw(list);
}

function all() { migrateOnce(); return readRaw() || []; }

// ---------------------------------------------------------------- CRUD -------
export function listCredentials() {
  // Admin-only UI: return values so the tab can reveal/copy them.
  return all().map((c) => ({
    id: c.id, name: c.name, value: c.value || "", notes: c.notes || "",
    createdAt: c.createdAt, updatedAt: c.updatedAt,
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
  for (const k of ["name", "value", "notes"]) if (k in patch) c[k] = patch[k];
  c.name = (c.name || "Untitled").trim();
  c.updatedAt = nowIso(); writeRaw(list); return c;
}
export function deleteCredential(id) {
  const list = all(); const i = list.findIndex((x) => x.id === id); if (i < 0) return false;
  list.splice(i, 1); writeRaw(list); return true;
}
export function duplicateCredential(id) {
  const list = all(); const c = list.find((x) => x.id === id); if (!c) return null;
  const copy = { ...c, id: randomUUID(), name: c.name + " (copy)", createdAt: nowIso(), updatedAt: nowIso() };
  list.push(copy); writeRaw(list); return copy;
}

// ------------------------------------------------- lookup for the bot tool ---
// Returns a formatted markdown string of matching credentials (or all when no
// service is given). Used by the get_credentials tool. Falls back to scanning the
// legacy credentials.md for a match not represented in the JSON store.
export function lookupCredentials(service) {
  const entries = all();
  const q = (service || "").trim().toLowerCase();
  const fmt = (c) => `## ${c.name}\n${c.value ? "Value: " + c.value + "\n" : ""}${c.notes || ""}`.trim();

  if (!q) {
    if (!entries.length) return "No credentials stored.";
    return entries.map(fmt).join("\n\n");
  }
  const hits = entries.filter((c) =>
    (c.name || "").toLowerCase().includes(q) ||
    (c.notes || "").toLowerCase().includes(q) ||
    (c.value || "").toLowerCase().includes(q));
  if (hits.length) return hits.map(fmt).join("\n\n");

  // legacy fallback
  if (existsSync(LEGACY_MD)) {
    try {
      const legacy = parseMarkdownSections(readFileSync(LEGACY_MD, "utf8"))
        .filter((e) => e.name.toLowerCase().includes(q) || (e.notes || "").toLowerCase().includes(q));
      if (legacy.length) return legacy.map((e) => `## ${e.name}\n${e.notes}`).join("\n\n");
    } catch { /* ignore */ }
  }
  return `No credentials found for "${service}"`;
}
