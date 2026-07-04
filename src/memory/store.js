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
export const MAX_MEMORY_BYTES = 80000; // ~20K tokens — fits the curated topic-memory set
export const MAX_MEMORY_FILES = 20;    // cap; the memory INDEX (buildMemoryIndex) covers anything beyond this

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

  const out = [];
  let usedBytes = 0;
  for (const name of names) {
    let bytes = 0, modified = 0;
    try { const st = statSync(join(MEMORY_DIR, name)); bytes = st.size; modified = st.mtimeMs; } catch {}
    // Only PINNED memories go into the prompt in full; the rest are read on demand
    // (they're still listed, with summaries, in the always-loaded index).
    if (!isPinned(name)) {
      out.push({ name, bytes, modified, loaded: false, reason: "read on demand (not pinned)" });
      continue;
    }
    const entryBytes = ("--- " + name + " ---\n").length + bytes; // wrapper the loader adds
    if (usedBytes + entryBytes > MAX_MEMORY_BYTES) {
      out.push({ name, bytes, modified, loaded: false, reason: "pinned but over the " + Math.round(MAX_MEMORY_BYTES / 1000) + "KB budget" });
      continue;
    }
    usedBytes += entryBytes;
    out.push({ name, bytes, modified, loaded: true, reason: null });
  }
  return { files: out, usedBytes };
}

// A one-line summary of a memory, for the always-loaded index: its frontmatter
// `description:` if present, else its first markdown heading, else its first
// meaningful line. Lets the model tell what a memory holds without reading it.
export function memorySummary(name) {
  let content;
  try { content = readMemory(name); } catch { return ""; }
  if (!content) return "";
  // Strip a leading frontmatter block; prefer its `description:` for the summary.
  let body = content;
  const fm = /^---\n([\s\S]*?)\n---\n?/.exec(content);
  if (fm) {
    const desc = /(?:^|\n)\s*description:\s*["']?(.+?)["']?\s*(?:\n|$)/.exec(fm[1]);
    if (desc && desc[1].trim()) return desc[1].trim().slice(0, 160);
    body = content.slice(fm[0].length);
  }
  for (const raw of body.split("\n")) {
    const line = raw.replace(/^#+\s*/, "").replace(/^\s*[-*]\s*/, "").trim();
    if (!line) continue;
    if (/^---/.test(line)) continue;
    if (/^(name|description|metadata|node_type|type|originSessionId|pinned):/i.test(line)) continue;
    if (/^\d{4}-\d{2}-\d{2}([ T-].*)?$/.test(line) && line.length < 40) continue; // skip bare date/time headings
    return line.slice(0, 160);
  }
  return "";
}

// A memory is "pinned" — injected into the prompt in full on every run — only if its
// frontmatter sets `pinned: true`. Everything else stays OUT of the prompt and is read
// on demand: the model sees it in the always-loaded index and pulls it with
// manage_memory when the topic comes up (the Claude-Code / progressive-disclosure model).
export function isPinned(name) {
  try {
    const head = readFileSync(join(MEMORY_DIR, name), "utf8").slice(0, 600);
    const fm = /^---\n([\s\S]*?)\n---/.exec(head);
    return !!(fm && /(?:^|\n)\s*pinned:\s*true\b/i.test(fm[1]));
  } catch { return false; }
}

// Compact index of EVERY memory (name + summary), newest first, so the model always
// knows what exists — including memories too old to be loaded in full — and can pull
// the relevant one on demand with manage_memory read. Cheap + stable (cached).
export function buildMemoryIndex(limit = 100) {
  ensureDir();
  let names;
  try { names = readdirSync(MEMORY_DIR).filter((f) => f.toLowerCase().endsWith(".md")).sort().reverse(); }
  catch { return ""; }
  if (!names.length) return "";
  const loaded = new Set(selectMemories().files.filter((f) => f.loaded).map((f) => f.name));
  const shown = names.slice(0, limit);
  const lines = shown.map((name) => {
    const s = memorySummary(name);
    return "- " + name + (loaded.has(name) ? " [pinned — in prompt]" : "") + (s ? " — " + s : "");
  });
  const extra = names.length > shown.length ? "\n(+" + (names.length - shown.length) + " older not shown — `manage_memory` list to see all)" : "";
  return lines.join("\n") + extra;
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
