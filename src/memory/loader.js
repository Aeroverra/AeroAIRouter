import { readFileSync, readdirSync, watch, existsSync } from "fs";
import { join } from "path";
import config from "../config/index.js";
import { PERSONA_DIR } from "../config/paths.js";

const DATA_DIR = config.dataDir;
let cachedStablePrompt = null;
let watchers = [];

// Persona files (soul/heartbeat/memory) live in AIROUTER_HOME/persona, separate
// from runtime data, so they can be user-authored and kept out of the repo.
function loadPersona(filename) {
  const path = join(PERSONA_DIR, filename);
  if (!existsSync(path)) return "";
  return readFileSync(path, "utf8");
}

const MAX_MEMORY_BYTES = 50000;

function loadMemoryFiles() {
  const memDir = join(DATA_DIR, "memory");
  if (!existsSync(memDir)) return "";
  const files = readdirSync(memDir)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .slice(-15);

  const parts = [];
  let totalBytes = 0;
  for (const f of files) {
    const content = readFileSync(join(memDir, f), "utf8");
    const entry = "--- " + f + " ---\n" + content;
    if (totalBytes + entry.length > MAX_MEMORY_BYTES) {
      console.log("[memory] Hit 50KB memory cap at " + parts.length + " files, skipping " + f + " (" + Math.round(entry.length / 1024) + "KB)");
      continue;
    }
    parts.push(entry);
    totalBytes += entry.length;
  }
  console.log("[memory] Loaded " + parts.length + " memory files (" + Math.round(totalBytes / 1024) + "KB)");
  return parts.join("\n\n");
}

export function buildStableSystemPrompt() {
  if (cachedStablePrompt) return cachedStablePrompt;

  const soul = loadPersona("soul.md");
  const memory = loadPersona("memory.md");
  const heartbeat = loadPersona("heartbeat.md");
  const recentMemories = loadMemoryFiles();

  const parts = [
    soul,
    "\n\n# LONG-TERM MEMORY\n\n" + memory,
    "\n\n# DISCORD ROUTING RULES\n\n" + heartbeat,
  ];

  if (recentMemories) {
    parts.push("\n\n# RECENT SESSION NOTES\n\n" + recentMemories);
  }

  let responseFormat =
    "\n\n# TOOLS AVAILABLE\n\nYou have access to tools for executing bash commands, reading files, writing files, and listing directories.\nUse these when asked to do tasks that require system access. Be careful with destructive operations.\n\n# RESPONSE FORMAT\n\nYou are responding in Discord. Keep messages under 2000 characters. Use Discord markdown.";
  const sigEmoji = config.persona && config.persona.emoji;
  if (sigEmoji) {
    responseFormat +=
      "\nYour signature emoji is " + sigEmoji + ". Use it to punctuate your messages, and end with it.";
  }
  parts.push(responseFormat);

  cachedStablePrompt = parts.join("");
  console.log("[memory] Built stable system prompt (" + cachedStablePrompt.length + " chars, ~" + Math.round(cachedStablePrompt.length / 4) + " tokens)");
  return cachedStablePrompt;
}

export function buildSystemPrompt(channelContext) {
  return buildStableSystemPrompt() + (channelContext ? "\n\n# CURRENT CONTEXT\n\n" + channelContext : "");
}

export function invalidateCache() {
  if (cachedStablePrompt) {
    console.log("[memory] Cache invalidated");
  }
  cachedStablePrompt = null;
}

export function startWatching() {
  for (const dir of [DATA_DIR, PERSONA_DIR]) {
    if (!existsSync(dir)) continue;
    const watcher = watch(dir, { recursive: true }, (event, filename) => {
      if (filename && filename.endsWith(".md")) {
        console.log("[memory] File changed: " + filename + ", invalidating cache");
        invalidateCache();
      }
    });
    watchers.push(watcher);
  }
}

export function stopWatching() {
  watchers.forEach((w) => w.close());
  watchers = [];
}
