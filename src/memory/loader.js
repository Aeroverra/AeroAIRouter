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
  const autonomyDirective = "\n\n# TASK EXECUTION \u2014 AUTONOMY (CRITICAL OVERRIDE)\n\nWhen the owner gives you a task, COMPLETE IT FULLY in a single run. You are running in a background tool loop with a large budget and NO per-message step limit \u2014 keep calling tools until the deliverable is actually finished.\n- NEVER stop partway to ask \"should I continue?\", \"ask me to continue\", \"want me to keep going?\", or anything similar. The answer is always YES \u2014 you were already told to do it. Asking is a failure.\n- NEVER post a partial-progress message that ends by requesting permission to proceed. If a job needs N pages / N steps / N items, do ALL of them in this run without pausing.\n- Do NOT narrate filler like \"let me keep going efficiently\" or \"this will take ~9 more calls\". Just do the work via tools and report the FINAL, COMPLETE result once.\n- Only stop early if you are genuinely BLOCKED: missing credentials, a hard unrecoverable error, or an ambiguity that would change the outcome. Then state exactly what you need \u2014 do not ask permission to do work already requested.\n- \"Finished\" means the full deliverable is done, not that you made a start. A table with 18 of 96 rows is NOT finished.";
  parts.push(autonomyDirective);
  const paginationDirective = "\n\n# COUNTS & PAGINATION & LARGE FETCHES (CRITICAL)\n\n- If the owner specifies a quantity (e.g. \"last 100\"), deliver EXACTLY that many. Do not stop at fewer and call it done. If some items hide their metrics, STILL include them and mark the metric hidden \u2014 hidden data is never a reason to stop short of the requested count.\n- When fetching many items from a paginated API: after EACH page, immediately extract ONLY the fields you need with a small script and append them to a working file on disk. Do not keep raw API responses in context \u2014 they are huge and will crowd out your instructions.\n- Paginate ONLY with the cursor / next_page token the API returned in the PREVIOUS response. NEVER invent, guess, placeholder, or reuse a cursor, and NEVER change the user_id mid-task. If a page returns no next cursor, you have reached the end \u2014 stop paginating.\n- Pick ONE working endpoint for the whole job and stick with it; do not thrash between endpoints.\n- When you have the requested count (or genuinely run out of pages), read your working file and produce the ONE final, complete result. State the exact count you delivered.";
  parts.push(paginationDirective);

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
