// Memory store: the bot's self-written notes live as markdown files in
// AIROUTER_HOME/data/memory/. Both the system-prompt builder (loader.js) and the
// config UI read through this module so they agree on exactly which files are
// injected into the prompt vs. skipped. Imports ONLY paths.js (never
// config/index.js), so the UI process can use it without triggering the bot's
// config validation / exit-on-missing-config.
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, renameSync, unlinkSync } from "fs";
import { join } from "path";
import { DATA_DIR } from "../config/paths.js";

export const MEMORY_DIR = join(DATA_DIR, "memory");

// Selection rules for what gets injected into the system prompt. Kept here so the
// UI can show the SAME loaded/skipped status the bot actually applies.
export const MAX_MEMORY_BYTES = 50000; // ~12.5K tokens
export const MAX_MEMORY_FILES = 15;    // most-recent N by name (names are date-prefixed)

// Sanitize a memory file name: a single path segment, markdown, safe chars only.
export function safeMemoryName(name) {
  let base = String(name || "").trim().replace(/\\/g, "/").split("/").pop() || "";
  base = base.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^-+|-+$/g, "");
  if (!base) throw new Error("invalid memory name");
  if (!/\.md$/i.test(base)) base += ".md";
  if (base.startsWith(".")) throw new Error("invalid memory name");
  return base;
}

function ensureDir() {
  if (!existsSync(MEMORY_DIR)) mkdirSync(MEMORY_DIR, { recursive: true });
}

// Ordered list of every memory file, tagged with whether it is loaded into the
// prompt and (if not) why. Selection mirrors the historical loader behavior:
// sort ascending by name, keep the most-recent MAX_MEMORY_FILES, then fit them
// under the byte budget in order (a file that would overflow is skipped, and we
// keep trying smaller later files).
export function selectMemories() {
  ensureDir();
  let names;
  try { names = readdirSync(MEMORY_DIR).filter((f) => f.toLowerCase().endsWith(".md")).sort(); }
  catch { return { files: [], usedBytes: 0 }; }

  const recent = new Set(names.slice(-MAX_MEMORY_FILES));
  const out = [];
  let usedBytes = 0;
  for (const name of names) {
    let bytes = 0, modified = 0;
    try { const st = statSync(join(MEMORY_DIR, name)); bytes = st.size; modified = st.mtimeMs; } catch {}
    if (!recent.has(name)) {
      out.push({ name, bytes, modified, loaded: false, reason: "not in the " + MAX_MEMORY_FILES + " most recent" });
      continue;
    }
    // account for the "--- name ---\n" wrapper the loader adds
    const entryBytes = ("--- " + name + " ---\n").length + bytes;
    if (usedBytes + entryBytes > MAX_MEMORY_BYTES) {
      out.push({ name, bytes, modified, loaded: false, reason: "over the 50KB prompt budget" });
      continue;
    }
    usedBytes += entryBytes;
    out.push({ name, bytes, modified, loaded: true, reason: null });
  }
  return { files: out, usedBytes };
}

// The exact text block injected into the system prompt (loader.js uses this).
export function buildMemoryText() {
  const { files } = selectMemories();
  const parts = [];
  for (const f of files) {
    if (!f.loaded) continue;
    const content = readMemory(f.name);
    parts.push("--- " + f.name + " ---\n" + content);
  }
  return parts.join("\n\n");
}

export function readMemory(name) {
  const path = join(MEMORY_DIR, safeMemoryName(name));
  if (!existsSync(path)) throw new Error("memory not found");
  return readFileSync(path, "utf8");
}

export function writeMemory(name, content) {
  ensureDir();
  const safe = safeMemoryName(name);
  writeFileSync(join(MEMORY_DIR, safe), String(content == null ? "" : content), "utf8");
  return safe;
}

export function appendMemory(name, content) {
  ensureDir();
  const safe = safeMemoryName(name);
  const path = join(MEMORY_DIR, safe);
  const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
  const sep = existing && !existing.endsWith("\n") ? "\n" : "";
  writeFileSync(path, existing + sep + String(content == null ? "" : content), "utf8");
  return safe;
}

export function deleteMemory(name) {
  const path = join(MEMORY_DIR, safeMemoryName(name));
  if (existsSync(path)) unlinkSync(path);
}

export function renameMemory(oldName, newName) {
  const from = join(MEMORY_DIR, safeMemoryName(oldName));
  const to = join(MEMORY_DIR, safeMemoryName(newName));
  if (!existsSync(from)) throw new Error("memory not found");
  if (existsSync(to)) throw new Error("a memory with that name already exists");
  renameSync(from, to);
  return safeMemoryName(newName);
}
