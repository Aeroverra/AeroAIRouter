import { readFileSync, watch, existsSync } from "fs";
import { join } from "path";
import config from "../config/index.js";
import { PERSONA_DIR, DATA_DIR, SKILLS_DIR } from "../config/paths.js";
import { selectMemories, buildMemoryText, buildMemoryIndex } from "./store.js";
import { buildSkillsPromptSection } from "../skills/loader.js";
import { toolSchemas, isExtraTool } from "../tools/definitions.js";
import { buildMcpPromptSection } from "../mcp/client.js";

let cachedStablePrompt = null;
let watchers = [];

// Persona files (soul/heartbeat/memory) live in AIROUTER_HOME/persona, separate
// from runtime data, so they can be user-authored and kept out of the repo.
function loadPersona(filename) {
  const path = join(PERSONA_DIR, filename);
  if (!existsSync(path)) return "";
  return readFileSync(path, "utf8");
}

// Recent session notes (AIROUTER_HOME/data/memory/*.md). Selection + byte budget
// live in ./store.js so the config UI's "loaded/skipped" view stays in sync.
function loadMemoryFiles() {
  const { files, usedBytes } = selectMemories();
  const loaded = files.filter((f) => f.loaded).length;
  const skipped = files.length - loaded;
  console.log("[memory] Loaded " + loaded + " memory files (" + Math.round(usedBytes / 1024) + "KB)" + (skipped ? ", skipped " + skipped : ""));
  return buildMemoryText();
}

// The real, generated tool inventory. Built from what actually loaded at
// startup (built-ins + every connected MCP server), never hand-written, so it
// can't drift from reality the way the old hardcoded "you have bash and file
// tools" blurb did. Its job is to stop capability denials: the model reads the
// prompt far more attentively than a wall of 150+ tool schemas, so if the
// prompt doesn't say a capability exists, it will confidently say it doesn't
// have it — while holding the tool.
function buildToolInventory() {
  const builtins = toolSchemas.filter((t) => !isExtraTool(t.name)).map((t) => t.name);
  return (
    "\n\n# YOUR TOOLS (LIVE INVENTORY)\n\n" +
    "Generated at startup from what is actually wired into you right now. If it is listed here, you HAVE it.\n\n" +
    "## Built-in\n\n" + builtins.join(", ") +
    buildMcpPromptSection() +
    "\n\n## Rules for using this inventory (CRITICAL)\n\n" +
    "- NEVER say \"I don't have an API/tool for that\", \"I'm not set up for that\", \"nothing in my memory about it\", or \"I'm drawing a blank\" until you have checked BOTH this inventory and the MEMORY INDEX. Guessing at your own capabilities is not allowed — you have denied having tools you were literally holding, and it is embarrassing.\n" +
    "- If any listed tool could plausibly do what was asked, CALL IT. Trying and failing is always better than claiming you can't. Do not ask the person to remind you what tools you have — that information is right here.\n" +
    "- Full descriptions of every tool are in your tool definitions. Scan them before answering any \"can you…\" / \"do you have…\" question.\n" +
    "- Social-media, web, DNS, infra and shop lookups go through the connected servers above, not a raw web_fetch of a login-walled page.\n" +
    "- Tool access is per-person: many tools are owner-only, so someone else's request may be refused for TRUST reasons. Say \"I can do that, but not for you\" — never \"I don't have that capability\". The CURRENT CONTEXT block tells you who you're talking to and their trust level.\n" +
    "- Never tell anyone you lack a capability that this inventory says you have."
  );
}

export function buildStableSystemPrompt() {
  if (cachedStablePrompt) return cachedStablePrompt;

  const soul = loadPersona("soul.md");
  const memory = loadPersona("memory.md");
  const heartbeat = loadPersona("heartbeat.md");
  const recentMemories = loadMemoryFiles();
  const memoryIndex = buildMemoryIndex();

  const parts = [
    soul,
    "\n\n# LONG-TERM MEMORY\n\n" + memory,
    "\n\n# DISCORD ROUTING RULES\n\n" + heartbeat,
  ];

  if (memoryIndex) {
    parts.push("\n\n# MEMORY INDEX\n\nEvery memory you have — the name plus a one-line summary of what each holds. Only the ones marked [pinned] are included in full below; for ANYTHING else, READ IT ON DEMAND with the manage_memory tool (action \"read\", exact name) the moment its topic comes up — the summary tells you which to open. Always check this index before saying you don't know or don't remember something.\n\n" + memoryIndex);
  }
  if (recentMemories) {
    parts.push("\n\n# PINNED MEMORIES (loaded in full)\n\n" + recentMemories);
  }

  // Enabled skills: only name + description here (loaded in full on demand via
  // the use_skill tool). Keeps the prompt small and cache-friendly.
  const skillsSection = buildSkillsPromptSection(config);
  if (skillsSection) parts.push(skillsSection);

  parts.push(buildToolInventory());

  let responseFormat =
    "\n\n# RESPONSE FORMAT\n\nYou are responding in Discord. Keep messages under 2000 characters. Use Discord markdown.";
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
  const blockedFetchDirective = "\n\n# BLOCKED WEB PAGES\n\nIf `web_fetch` returns `blocked:true` (a site's anti-bot protection — Cloudflare, a JS challenge, 403/429), immediately retry that EXACT url with the `camoufox__fetch_url` tool, which renders it in a stealth browser that bypasses bot detection. Only give up if Camoufox also fails, or the tool isn't installed (then say so).";
  parts.push(blockedFetchDirective);

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
  // data/ + persona/ + skills/ — any .md change rebuilds the stable prompt, so
  // edits made in the config UI (memories, persona, skill bodies) apply live
  // without a bot restart. (Enabling/disabling a skill lives in config.json and
  // still needs a restart, like plugins.)
  for (const dir of [DATA_DIR, PERSONA_DIR, SKILLS_DIR]) {
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
