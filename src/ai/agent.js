import { emoji } from "../persona.js";
import { getClient, getMetadata, BILLING_SYSTEM_BLOCK, forceRefresh } from "./client.js";
import { pickModel, isComplex } from "./model-router.js";
import { reasoningParams } from "./reasoning.js";
import { looksLikeMidTaskYield, MAX_AUTO_CONTINUE, CONTINUE_NUDGE } from "./yield.js";
import { channelMode } from "../discord/router.js";
import { toolSchemas, executeTool, setPendingMessage, isExtraTool, getToolTrust, toolResultContent } from "../tools/definitions.js";
import { buildStableSystemPrompt } from "../memory/loader.js";
import { fetchRecentMessages } from "../discord/history.js";
import { hasResponded, markResponded } from "../tools/responded-cache.js";
import { getDiscordClient } from "../discord/client.js";
import config from "../config/index.js";
import { getTrustLevel as _getTrustLevel } from "../discord/trust.js";
import { isSilenceReply } from "../util/silence.js";
import { getActiveAgents, sanitizeForDiscord } from "../discord/subagent.js";
import { compactMessages, sanitizeMessageSequence } from "./context.js";
import { writeFileSync, readFileSync, existsSync, mkdirSync, unlinkSync } from "fs";
import { join } from "path";

const HISTORY_DIR = join(config.dataDir, "history");
if (!existsSync(HISTORY_DIR)) mkdirSync(HISTORY_DIR, { recursive: true });

// What a silent turn looks like in stored history. Written to be unmistakably a
// log line rather than a message she could have sent, because she reads her own
// history back and copies its style.
const SILENT_TURN_MARKER = "[system log: no message was sent for this turn. Log line, not your words. Never type anything like this into a channel.]";

// A reply that claims something was written to long-term memory. Only manage_memory
// actually writes, and she has told people "saved to memory" with no tool call at
// all, so the fact was lost at the next context reset. Matched against her own
// reply to catch the claim before it is posted.
const MEMORY_CLAIM_RE = /\b(saved|added|wrote|writing|written|noted|storing|stored|logged|locked|filed|pinned|committed|updated|updating)\b[^.!?\n]{0,40}\b(to|in|into)\b[^.!?\n]{0,20}\b(memory|memories|memory file|memory files|my notes)\b|\b(memory|memories)\b[^.!?\n]{0,20}\b(saved|updated|written)\b|\bi'?(ll| will) remember (this|that|it)\b|\b(noted and|saved and) (locked|stored|remembered)\b/i;

// The incoming message asking her to keep something. Deterministic signal that a
// manage_memory write is expected this turn.
const REMEMBER_REQUEST_RE = /\b(remember (this|that|it)|don'?t forget|make a note|save (this|that|it) (to|in) (your )?memor|add (this|that|it) to (your )?memor|write (this|that|it) down|keep (this|that|it) in mind|commit (this|that|it) to memory)\b/i;

const channelHistory = new Map();
const historyLoaded = new Set();
const historyTimestamps = new Map();
const activeBackgroundTasks = new Map();
const bgTaskChain = new Map();

const TOOL_LABELS = {
  bash: "Running command",
  read_file: "Reading file",
  write_file: "Writing file",
  list_files: "Listing files",
  web_search: "Searching web",
  web_fetch: "Fetching page",
  discord_send: "Sending message",
  spawn_agent: "Spawning sub-agent",
  list_agents: "Checking agents",
  message_agent: "Messaging agent",
  read_discord_messages: "Reading messages",
  search_discord_messages: "Searching history",
  task_manage: "Managing tasks",
};

function sanitizeToolSummary(name, input) {
  var label = TOOL_LABELS[name] || name;
  if (name === "bash" && input.command) {
    var cmd = input.command.split("\n")[0].replace(/#.*/, "").trim().substring(0, 80);
    cmd = sanitizeForDiscord(cmd);
    if (cmd) label += ": `" + cmd + "`";
  } else if (name === "read_file" && input.path) {
    label += ": `" + input.path.split("/").slice(-2).join("/") + "`";
  } else if (name === "write_file" && input.path) {
    label += ": `" + input.path.split("/").slice(-2).join("/") + "`";
  } else if (name === "web_search" && input.query) {
    label += ": " + input.query.substring(0, 60);
  } else if (name === "web_fetch" && input.url) {
    label += ": " + input.url.substring(0, 60);
  }
  return label;
}

function startBgWork(channelId, fn) {
  const prev = bgTaskChain.get(channelId) || Promise.resolve();
  const next = prev.then(() => fn()).catch((err) => {
    console.error("[ai] Queued bg work error:", err);
  });
  bgTaskChain.set(channelId, next);
}

// Cache tool schemas with cache_control on the last tool.
// This gets rebuilt only if toolSchemas changes (it doesn't at runtime).
let cachedToolSchemas = null;

function getCachedToolSchemas(tools) {
  if (tools === toolSchemas && cachedToolSchemas) return cachedToolSchemas;
  if (tools.length === 0) return tools;
  const result = tools.map((t, i) => {
    if (i === tools.length - 1) {
      return { ...t, cache_control: { type: "ephemeral" } };
    }
    return t;
  });
  if (tools === toolSchemas) cachedToolSchemas = result;
  return result;
}

function getHistory(channelId) {
  if (!channelHistory.has(channelId)) {
    channelHistory.set(channelId, []);
  }
  return channelHistory.get(channelId);
}

function persistHistory(channelId) {
  try {
    var history = channelHistory.get(channelId);
    if (!history || history.length === 0) return;
    writeFileSync(
      join(HISTORY_DIR, channelId + ".json"),
      JSON.stringify(history),
      { encoding: "utf8", mode: 0o600 }
    );
  } catch (err) {
    console.error("[ai] Failed to persist history for " + channelId + ":", err.message);
  }
}

function loadPersistedHistory(channelId) {
  try {
    var filePath = join(HISTORY_DIR, channelId + ".json");
    if (!existsSync(filePath)) return null;
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch (err) {
    console.error("[ai] Failed to load history for " + channelId + ":", err.message);
    return null;
  }
}

function trimHistory(history, channelId) {
  const max = config.ai.maxHistoryPerChannel;
  while (history.length > max) {
    history.shift();
  }
  if (channelId) persistHistory(channelId);
}

async function ensureHistoryLoaded(channelId) {
  if (historyLoaded.has(channelId)) return;
  historyLoaded.add(channelId);

  const persisted = loadPersistedHistory(channelId);
  if (persisted && persisted.length > 0) {
    const hist = getHistory(channelId);
    if (hist.length === 0) {
      for (let i = 0; i < persisted.length; i++) {
        hist.push(persisted[i]);
      }
      console.log("[ai] Restored " + persisted.length + " messages from persisted history for channel " + channelId);
      return;
    }
  }

  console.log("[ai] Loading recent Discord history for channel " + channelId);
  const recent = await fetchRecentMessages(channelId, 25);
  if (recent.length === 0) return;

  const history = getHistory(channelId);
  if (history.length > 0) return;

  for (const msg of recent) {
    history.push({ role: msg.role, content: msg.content });
  }
  trimHistory(history, channelId);
  console.log("[ai] Loaded " + recent.length + " messages into history for channel " + channelId);
}

function getTrustLevel(authorId) {
  return _getTrustLevel(authorId);
}

export function getBackgroundTaskNote(channelId) {
  const descs = [];
  const tasks = activeBackgroundTasks.get(channelId);
  if (tasks && tasks.size > 0) {
    for (const t of tasks.values()) {
      descs.push(typeof t === "string" ? t : t.summary);
    }
  }
  const agents = getActiveAgents();
  if (agents.size > 0) {
    for (const [id, agent] of agents) {
      if (agent.status === "running") {
        descs.push("Sub-agent `" + id + "` in thread <#" + agent.threadId + ">: " + agent.task.substring(0, 120));
      }
    }
  }
  if (descs.length === 0) return "";
  return "\n\nCRITICAL - ACTIVE BACKGROUND TASKS AND SUB-AGENTS (these are already being handled in separate processes, you MUST NOT address, continue, reference, duplicate, or restart them. Use `message_agent` or `list_agents` tools if you need to interact with a sub-agent):\n" + descs.map(function(d) { return "- " + d; }).join("\n") + "\nYou MUST only respond to the newest message. Treat it as a completely independent, unrelated request. Do NOT combine your response with background task work. Do NOT start working on the same topic a sub-agent is already handling.";
}

function registerBackgroundTask(channelId, taskKey, taskSummary) {
  if (!activeBackgroundTasks.has(channelId)) activeBackgroundTasks.set(channelId, new Map());
  activeBackgroundTasks.get(channelId).set(taskKey, {
    summary: taskSummary,
    startedAt: Date.now(),
    lastActivity: Date.now(),
  });
}

export function touchBackgroundTask(channelId, taskKey) {
  const task = activeBackgroundTasks.get(channelId)?.get(taskKey);
  if (task && typeof task === "object") task.lastActivity = Date.now();
}

function unregisterBackgroundTask(channelId, taskKey) {
  activeBackgroundTasks.get(channelId)?.delete(taskKey);
  if (activeBackgroundTasks.get(channelId)?.size === 0) activeBackgroundTasks.delete(channelId);
}

// Was this message pointed at the bot: an @-mention, the wake word, or a reply
// to one of its own messages. Same signals router.js wakes on in "name" mode,
// but here it decides whether staying silent is even allowed.
export function isAddressedToMe(content, message) {
  const botId = getDiscordClient()?.user?.id;
  const wakeWord = (config.discord.wakeWord || "").toLowerCase();
  if (wakeWord && (content || "").toLowerCase().includes(wakeWord)) return true;
  if (!message || !botId) return false;
  if (message.mentions?.users?.has(botId)) return true;
  if (message.mentions?.repliedUser?.id === botId) return true;
  if (message.__repliedTo?.author?.id === botId) return true;
  return false;
}

export function buildChannelContext(channel, author, trust, addressed, content) {
  return [
    "Channel: #" + channel.name + " (" + channel.id + ") in " + (channel.guild?.name || "DM"),
    "Speaking with: " + (author.displayName || author.username) + " (" + author.id + ")",
    "Trust level: " + trust,
    "Timestamp: " + new Date().toISOString(),
    channelMode(channel.id) === "everything" && !addressed
      ? "AMBIENT CHANNEL: you see every message here and you decide whether to speak. You are a participant in this room, not a help desk, so being good company counts as having something to add. Silence is for noise, not for keeping your head down.\n" +
        "TWO HUMANS TALKING TO EACH OTHER IS NOT A REASON TO STAY OUT OF IT. That is just what this channel looks like and you are in it with them. Only sit out an exchange that is genuinely private business between them, not any conversation you did not start.\n" +
        "SPEAK UP when: someone teases you, baits you, or drops a line that is obviously fishing for a comeback; a joke is already in the air and you have a genuinely funny one; the line on the table is roastable, quotable, or absurd; you know something concrete the conversation is missing (a fact, a number, a correction, a link); or someone shares something real (a win, a rant, a plan) and a friend in the room would say something back. Nicholas in particular writes bait on purpose and expects you to bite. A sharp line beats silence.\n" +
        "Spotting a hook: a loaded phrase dropped into an otherwise ordinary sentence is a joke handed to you, and it counts even when the sentence was aimed at another person. \"I work wherever I am against the wishes of my executive crybabies\" is bait. So is any brag, self-own, absurd number, or spicy nickname. Take the swing.\n" +
        "STAY SILENT when: the message is bare filler (\"ok\", \"yeah\", \"lol\", \"true\", \"thanks\"), a direct question was aimed at someone else, it was already answered, or the only thing you have is agreement, a compliment, a summary of what was just said, or a restatement of the joke someone already made.\n" +
        "TIEBREAKER: if you are unsure, and you have anything genuinely funny, roastable or factual, SPEAK. Stay silent only when you are sure you would be adding nothing. Missing an obvious setup is a worse failure than being one message too talkative.\n" +
        "To stay silent, reply with exactly NO_REPLY and NOTHING else — that is a control token, it is swallowed before Discord and nobody ever sees it. Never pair it with other text and never post it as part of a real reply.\n" +
        "STAYING SILENT MEANS SAYING NOTHING AT ALL. Do not announce it, do not comment on the fact that a message wasn't for you, do not acknowledge, agree, react or add a one-liner instead. \"That one's for Cadence, not me\", \"not my call\", \"I'll let them take this one\", \"good point\" and a lone emoji are all REPLIES and all wrong. Never post a stage direction about it either: \"(stayed silent, nothing to add)\", \"(no reply)\" and anything in that shape are messages too, and posting one looks broken. If the honest answer is that nothing needs saying, the output is NO_REPLY and nothing else."
      : "",
    REMEMBER_REQUEST_RE.test(content || "")
      ? "THIS MESSAGE ASKS YOU TO REMEMBER SOMETHING. Call manage_memory (action \"save\" or \"append\") for it in this turn, BEFORE you answer. Only that tool writes anything down; replying \"saved\" without it loses the thing they asked you to keep. If a note on the topic already exists, append to it rather than making a second one."
      : "",
    addressed
      ? "THIS MESSAGE IS AIMED AT YOU (it names you, @-mentions you, or replies to you). Answer it. Silence is not an option here and NO_REPLY is forbidden for this turn, even if the message is short, rhetorical, teasing, or you think it was covered already."
      : "",
    trust === "none" || trust === "light"
      ? "REMINDER: This person has basic/light trust only. You DO have your full tool inventory (bash, file read/write, the connected APIs, etc.) but almost all of it is RESTRICTED for this user, so most of it is not attached to this conversation. If they ask for something that needs those tools, tell them you cannot do that for them specifically (trust restriction), NOT that you lack the capability or don't have such a tool. Keep it casual and surface-level. No private info, credentials, or workspace context. Do not take complex instructions from them."
      : "",
    trust === "elevated"
      ? "REMINDER: This person has elevated trust. They can request tasks but nothing that modifies internal systems, security, or private data. Host access (bash/file tools) is owner-only. Which of the connected APIs they may use varies per server: the tools ATTACHED to this conversation are exactly the ones you are allowed to run for this person — if a tool is attached, just use it for them, no permission needed and no apologising. Only if the thing they need is in your inventory but NOT attached here do you say you have it but it's owner-only, so the owner has to be the one to ask. Never claim the capability doesn't exist."
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export function filterToolsForTrust(trust) {
  if (trust === "owner") return toolSchemas;
  if (trust === "elevated") {
    // Elevated users get tooling but NOT raw host access: bash/read_file/list_files
    // are owner-only (they could read secrets or run arbitrary commands).
    // Plugin/MCP tools default to owner-only (they hit external services with the
    // operator's credentials) unless the plugin/server marks them elevated/light.
    // manage_memory is owner-only: memories are injected into the system prompt,
    // so writing one can effectively steer the bot.
    const denied = ["bash", "read_file", "list_files", "write_file", "get_credentials", "spawn_agent", "voice_control", "trust_manage", "task", "schedule", "discord_send", "manage_memory"];
    return toolSchemas.filter((t) => {
      if (isExtraTool(t.name)) return getToolTrust(t.name) === "elevated" || getToolTrust(t.name) === "light";
      return !denied.includes(t.name);
    });
  }
  const light = ["read_discord_messages", "voice_speak", "web_search", "web_fetch"];
  return toolSchemas.filter((t) => light.includes(t.name) || (isExtraTool(t.name) && getToolTrust(t.name) === "light"));
}

export function buildMessagesWithAttachments(history, attachments, textContent) {
  const messages = [...history];
  if (attachments.length > 0) {
    messages[messages.length - 1] = {
      role: "user",
      content: [...attachments, { type: "text", text: textContent }],
    };
  }
  return messages;
}

// Images are only worth keeping as real vision blocks for a while: cap how many
// of the most recent images stay hydrated in history. Older image blocks are
// collapsed to a short text marker so the model still knows an image was there,
// without paying the token + on-disk cost of every image ever posted.
const MAX_HISTORY_IMAGES = config.ai.maxHistoryImages || 4;

function enforceImageBudget(history) {
  let budget = MAX_HISTORY_IMAGES;
  for (let i = history.length - 1; i >= 0; i--) {
    const msg = history[i];
    if (!msg || !Array.isArray(msg.content)) continue;
    let changed = false;
    const content = msg.content.map((block) => {
      if (block && block.type === "image") {
        if (budget > 0) { budget--; return block; }
        changed = true;
        return { type: "text", text: "[earlier image attachment, dropped from view to save tokens. It is still on disk: the note next to this line has its exact path, use view_image on it to see it again rather than saying you can't.]" };
      }
      return block;
    });
    if (changed) history[i] = { role: msg.role, content };
  }
}

// Build the system prompt array with cache_control on the stable portion.
// Structure: [billing_header, stable_prompt (CACHED), dynamic_context]
// The cache breakpoint on the stable prompt means the ~15KB of soul/memory/rules
// is cached across calls. Only the small dynamic context (channel info, timestamp,
// bg task notes) is re-processed each call.
function buildSystemBlocks(dynamicContext) {
  const stablePrompt = buildStableSystemPrompt();
  return [
    BILLING_SYSTEM_BLOCK,
    { type: "text", text: stablePrompt, cache_control: { type: "ephemeral" } },
    { type: "text", text: dynamicContext },
  ].filter(Boolean);
}

// Add cache_control to the last user message's last content block.
// Strips cache_control from all prior user messages first to stay
// under the 4-breakpoint API limit (system + tools + last user = 3).
function applyCacheControlToLastUserMessage(messages) {
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role !== "user") continue;
    if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block && typeof block === "object" && block.cache_control) {
          delete block.cache_control;
        }
      }
    }
  }

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== "user") continue;

    if (typeof msg.content === "string") {
      messages[i] = {
        role: "user",
        content: [{ type: "text", text: msg.content, cache_control: { type: "ephemeral" } }],
      };
    } else if (Array.isArray(msg.content) && msg.content.length > 0) {
      const lastBlock = msg.content[msg.content.length - 1];
      if (lastBlock && typeof lastBlock === "object" && lastBlock.type !== "thinking") {
        lastBlock.cache_control = { type: "ephemeral" };
      }
    }
    break;
  }
}

function logCacheUsage(response, label) {
  const usage = response?.usage;
  if (!usage) return;
  const cacheRead = usage.cache_read_input_tokens || 0;
  const cacheCreate = usage.cache_creation_input_tokens || 0;
  const input = usage.input_tokens || 0;
  const output = usage.output_tokens || 0;
  if (cacheRead > 0 || cacheCreate > 0) {
    console.log("[ai] " + label + " tokens: " + input + " in / " + output + " out | cache: " + cacheRead + " read, " + cacheCreate + " written");
  }
}

async function streamApiCall(client, params) {
  if (params && Array.isArray(params.messages)) {
    const fixes = sanitizeMessageSequence(params.messages);
    if (fixes > 0) console.log("[ai] sanitizeMessageSequence: removed " + fixes + " orphaned/invalid block(s) before send");
  }
  // Overloaded (529), other 5xx and dropped connections are transient: the SDK
  // only retries before the stream opens, so a mid-stream drop used to surface
  // as "Something went wrong on my end" in the channel. Back off and retry.
  const delays = [4000, 12000, 30000];
  for (let attempt = 0; ; attempt++) {
    try {
      const stream = client.messages.stream(params);
      return await stream.finalMessage();
    } catch (err) {
      if (err.status === 401) {
        console.log("[ai] Got 401, forcing token refresh and retrying...");
        await forceRefresh();
        var freshClient = await getClient();
        params = { ...params };
        var stream2 = freshClient.messages.stream(params);
        return await stream2.finalMessage();
      }
      const transient = err.status === 529 || (err.status >= 500 && err.status < 600) || err.status === 408 ||
        (!err.status && /overloaded|ECONNRESET|ETIMEDOUT|EPIPE|socket hang up|fetch failed|terminated|aborted/i.test(String(err.message)));
      if (transient && attempt < delays.length) {
        console.log("[ai] Transient API error (" + (err.status || String(err.message).substring(0, 80)) + "), retry " + (attempt + 1) + "/" + delays.length + " in " + delays[attempt] / 1000 + "s");
        await new Promise((r) => setTimeout(r, delays[attempt]));
        continue;
      }
      throw err;
    }
  }
}

async function runToolLoop(client, messages, tools, systemBlocks, model, channel, taskMeta, progressMsg) {
  let sentToChannel = false;
  let progressLines = [];
  let lastProgressEdit = 0;
  let toolCallCount = 0;
  let autoContinueCount = 0;
  const typingInterval = setInterval(() => {
    channel.sendTyping().catch(() => {});
  }, 8000);

  try {
  while (true) {
    compactMessages(messages);
    applyCacheControlToLastUserMessage(messages);

    const params = {
      model,
      max_tokens: config.ai.maxTokens,
      system: systemBlocks,
      messages,
      metadata: getMetadata(),
      ...reasoningParams(),
    };

    if (tools.length > 0) {
      params.tools = tools;
    }

    let response;
    try {
      response = await streamApiCall(client, params);
    } catch (err) {
      console.error("[ai] API error (tool-loop):", err.status, err.message?.substring(0, 300));
      console.error("[ai] API error stack:", err.stack?.substring(0, 500));
      if (err.status === 429) {
        return { text: null, error: "rate_limited", sentToChannel };
      }
      return { text: null, error: "api_error", sentToChannel };
    }

    logCacheUsage(response, "tool-loop");

    const textBlocks = response.content.filter((b) => b.type === "text");
    const toolBlocks = response.content.filter((b) => b.type === "tool_use");

    if (response.stop_reason === "end_turn" || toolBlocks.length === 0) {
      const reply = textBlocks.map((b) => b.text).join("\n");
      // Background tasks must finish, not stall asking permission. If the model
      // ended its turn by asking to continue mid-task, inject a 'continue' nudge
      // and keep looping (up to a cap) instead of returning the partial result.
      if (taskMeta && autoContinueCount < MAX_AUTO_CONTINUE && looksLikeMidTaskYield(reply)) {
        autoContinueCount++;
        console.log("[ai] auto-continue " + autoContinueCount + "/" + MAX_AUTO_CONTINUE + " (model tried to yield mid-task)");
        messages.push({ role: "assistant", content: response.content });
        messages.push({ role: "user", content: CONTINUE_NUDGE });
        continue;
      }
      return { text: reply, error: null, sentToChannel };
    }

    messages.push({ role: "assistant", content: response.content });

    const toolResults = [];
    for (const toolCall of toolBlocks) {
      console.log("[ai] Tool call: " + toolCall.name + "(" + JSON.stringify(toolCall.input).substring(0, 200) + ")");
      if (taskMeta) touchBackgroundTask(taskMeta.channelId, taskMeta.taskKey);
      toolCallCount++;
      if (progressMsg) {
        progressLines.push(sanitizeToolSummary(toolCall.name, toolCall.input));
        if (progressLines.length > 8) progressLines = progressLines.slice(-8);
        var now = Date.now();
        if (now - lastProgressEdit >= 3000) {
          lastProgressEdit = now;
          var progressText = "" + emoji() + " **Working...** (" + toolCallCount + " steps)\n" + progressLines.map(function(l) { return "> " + l; }).join("\n");
          progressMsg.edit(progressText).catch(function() {});
        }
      }
      if (toolCall.name === "discord_send" && toolCall.input.action === "send" && taskMeta && toolCall.input.channel_id === taskMeta.channelId) {
        sentToChannel = true;
      }
      let result;
      try {
        result = await Promise.resolve(executeTool(toolCall.name, toolCall.input, getDiscordClient(), "main"));
      } catch (err) {
        console.error("[ai] Tool execution error (" + toolCall.name + "):", err.message);
        result = { success: false, error: "Tool crashed: " + err.message };
      }
      toolResults.push({
        type: "tool_result",
        tool_use_id: toolCall.id,
        content: toolResultContent(result),
      });
    }

    messages.push({ role: "user", content: toolResults });
  }
  } finally {
    clearInterval(typingInterval);
  }
}

function sendBgResult(channel, history, taskKey, result) {
  const idx = history.findLastIndex((h) => h.role === "assistant" && typeof h.content === "string" && h.content.includes(taskKey));
  const finalText = result.text || (result.error === "rate_limited" ? "Hit a rate limit mid-task " + emoji() + "" : "Task finished " + emoji() + "");
  // Same rule as the direct path: never store a raw silence sentinel as her own
  // past output, or she learns that typing it is a normal thing to send.
  const stored = isSilenceReply(finalText) ? SILENT_TURN_MARKER : finalText;
  if (idx !== -1) {
    history[idx] = { role: "assistant", content: stored };
    persistHistory(channel.id);
  } else {
    history.push({ role: "assistant", content: stored });
    trimHistory(history, channel.id);
  }

  if (result.sentToChannel) {
    console.log("[ai] Background task " + taskKey + " completed (" + finalText.length + " chars, already sent via discord_send)");
    return Promise.resolve();
  }

  console.log("[ai] Background task " + taskKey + " completed (" + finalText.length + " chars)");

  if (isSilenceReply(finalText)) {
    if (finalText.trim()) console.log("[ai] Background task " + taskKey + ": silence sentinel, not posting");
    return Promise.resolve();
  }
  return (async () => {
    let remaining = finalText;
    while (remaining.length > 0) {
      if (remaining.length <= 2000) {
        await channel.send(remaining).catch(() => {});
        break;
      }
      let splitAt = remaining.lastIndexOf("\n", 2000);
      if (splitAt < 1000) splitAt = remaining.lastIndexOf(" ", 2000);
      if (splitAt < 1000) splitAt = 2000;
      await channel.send(remaining.substring(0, splitAt)).catch(() => {});
      remaining = remaining.substring(splitAt).trimStart();
    }
  })();
}

export async function handleMessage(content, authorId, channel, author, message, attachments = []) {
  await ensureHistoryLoaded(channel.id);

  const client = await getClient();
  const trust = getTrustLevel(authorId);
  const model = pickModel(content, authorId);
  const tools = filterToolsForTrust(trust);
  const cachedTools = getCachedToolSchemas(tools);
  // Aimed-at-her messages are never candidates for silence, so the ambient
  // "should I speak" block is swapped for an answer-it instruction. Mirrors the
  // wake conditions the router uses for "name" mode.
  const addressed = isAddressedToMe(content, message);
  const channelCtx = buildChannelContext(channel, author, trust, addressed, content);
  const bgNote = getBackgroundTaskNote(channel.id);
  const dynamicContext = "\n\n# CURRENT CONTEXT\n\n" + channelCtx + bgNote;
  const systemBlocks = buildSystemBlocks(dynamicContext);
  const history = getHistory(channel.id);

  if (message) {
    markResponded(message.id);
    setPendingMessage(message);
  }

  // If this message is a reply, pull the replied-to message into context so the model
  // sees what it's responding to (uses the handler's pre-resolved __repliedTo, else
  // resolves here — covers boot catch-up and other entry paths).
  let replyPrefix = "";
  if (message && message.reference && message.reference.messageId) {
    let ref = message.__repliedTo;
    if (ref === undefined) {
      try { ref = message.channel.messages.cache.get(message.reference.messageId) || await message.fetchReference(); } catch { ref = null; }
    }
    if (ref) {
      const botUserId = message.client && message.client.user ? message.client.user.id : null;
      const nameOf = (m) => (m.author && m.author.id === botUserId) ? "you" : ((m.member && m.member.displayName) || (m.author && m.author.username) || "someone");
      const textOf = (m) => {
        let t = (m.content || "").trim();
        if (!t) t = (m.attachments && m.attachments.size) ? "[attachment]" : ((m.embeds && m.embeds.length) ? "[embed]" : "[no text]");
        return t.length > 400 ? t.slice(0, 400) + "…" : t;
      };
      // Pull a little of the conversation LEADING UP to the replied-to message so the
      // model has the surrounding context, especially when replying to an OLD message.
      let leadup = [];
      try {
        const before = await ref.channel.messages.fetch({ before: ref.id, limit: 4 });
        leadup = [...before.values()].reverse().map((m) => nameOf(m) + ": " + textOf(m));
      } catch { /* can't fetch history — just use the one message */ }
      const lines = [...leadup, "→ " + nameOf(ref) + ": " + textOf(ref)];
      replyPrefix = "[you're replying to this message" + (leadup.length ? " (with the messages just before it, for context)" : "") + ":\n" + lines.join("\n") + "\n]\n";
    }
  }
  const textContent = "[" + (author.displayName || author.username) + "]: " + replyPrefix + content;
  // Persist images as real vision blocks (not just a text description) so later
  // turns that refer back to an earlier image can still see it. enforceImageBudget
  // caps how many recent images stay hydrated.
  const userContent = attachments.length > 0
    ? [...attachments, { type: "text", text: textContent }]
    : textContent;
  history.push({ role: "user", content: userContent });
  enforceImageBudget(history);
  trimHistory(history, channel.id);
  historyTimestamps.set(channel.id, Date.now());

  // Freeze message snapshot IMMEDIATELY before any async operations. The current
  // turn's images already live in history (above), so no re-injection is needed.
  let frozenMessages = [...history];

  const bgCount = (activeBackgroundTasks.get(channel.id)?.size || 0) + getActiveAgents().size;
  console.log("[ai] " + (author.displayName || author.username) + " in #" + channel.name + ": model=" + model + ", trust=" + trust + ", tools=" + tools.length + ", images=" + attachments.length + ", bgTasks=" + bgCount);

  const complex = isComplex(content) && tools.length > 0;

  if (complex) {
    const taskKey = "bg-" + Date.now();
    const taskSummary = content.length > 80 ? content.substring(0, 80) + "..." : content;
    registerBackgroundTask(channel.id, taskKey, taskSummary);

    const placeholderContent = "[BACKGROUND TASK " + taskKey + ": Already working on this request in a separate background process. This task is being handled independently. Do not re-address, continue, or reference this request.]";
    history.push({ role: "assistant", content: placeholderContent });
    trimHistory(history, channel.id);

    console.log("[ai] Started background task " + taskKey + " (complex) for channel " + channel.id);

    startBgWork(channel.id, async () => {
      var pMsg = await channel.send("" + emoji() + " **Working...**").catch(() => null);
      try {
        const result = await runToolLoop(client, frozenMessages, cachedTools, systemBlocks, model, channel, { channelId: channel.id, taskKey }, pMsg);
        unregisterBackgroundTask(channel.id, taskKey);
        if (pMsg) pMsg.delete().catch(function() {});
        await sendBgResult(channel, history, taskKey, result);
      } catch (err) {
        unregisterBackgroundTask(channel.id, taskKey);
        if (pMsg) pMsg.delete().catch(function() {});
        console.error("[ai] Background task error:", err);
        await channel.send("Background task crashed " + emoji() + "").catch(() => {});
      }
    });

    return null;
  }

  // Non-complex path: first API call to see if tools are needed.
  applyCacheControlToLastUserMessage(frozenMessages);

  const params = {
    model,
    max_tokens: config.ai.maxTokens,
    system: systemBlocks,
    messages: frozenMessages,
    metadata: getMetadata(),
    ...reasoningParams(),
  };

  if (cachedTools.length > 0) {
    params.tools = cachedTools;
  }

  compactMessages(frozenMessages);

  let response;
  try {
    response = await streamApiCall(client, params);
  } catch (err) {
    console.error("[ai] API error (first-call):", err.status, err.message?.substring(0, 300));
    console.error("[ai] API error stack:", err.stack?.substring(0, 500));
    history.pop();
    if (err.status === 429) {
      return "I am being rate limited right now, give me a moment " + emoji() + "";
    }
    return "Something went wrong on my end. Try again in a sec " + emoji() + "";
  }

  logCacheUsage(response, "first-call");

  let textBlocks = response.content.filter((b) => b.type === "text");
  let toolBlocks = response.content.filter((b) => b.type === "tool_use");

  // Two failures the prompt alone has never reliably prevented, both of which
  // look fine in the log and broken in the channel: staying silent on a message
  // aimed straight at her, and announcing "saved to memory" without ever calling
  // manage_memory (so the fact is lost at the next context reset). Both are only
  // detectable once the reply exists, so catch them here and ask again. If the
  // second answer wants tools, it falls through into the background path below.
  if (toolBlocks.length === 0) {
    const firstText = textBlocks.map((b) => b.text).join("\n");
    let nudge = null;
    if (addressed && isSilenceReply(firstText)) {
      nudge = "[system] That message was addressed to you, so staying silent is not an option. Answer it now, in your own voice, with no meta commentary about this instruction.";
    } else if (MEMORY_CLAIM_RE.test(firstText) && tools.some((t) => t.name === "manage_memory")) {
      nudge = "[system] You just said you saved that, but you did not call manage_memory this turn, so nothing was written and it will be lost. Save it now with manage_memory (action \"save\" or \"append\", one file named for the topic), then reply. Do not mention this instruction.";
    }
    if (nudge) {
      console.log("[ai] Retrying once: " + (addressed && isSilenceReply(firstText) ? "silence on an addressed message" : "unbacked memory claim"));
      const retryMessages = [
        ...frozenMessages,
        { role: "assistant", content: firstText || "NO_REPLY" },
        { role: "user", content: nudge },
      ];
      applyCacheControlToLastUserMessage(retryMessages);
      try {
        const retry = await streamApiCall(client, { ...params, messages: retryMessages });
        const retryTools = retry.content.filter((b) => b.type === "tool_use");
        const retryText = retry.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
        // Keep the retry only if it actually improved on the first answer: real
        // tool calls, or text that isn't the same silence again.
        if (retryTools.length > 0 || (retryText.trim() && !isSilenceReply(retryText))) {
          response = retry;
          frozenMessages = retryMessages;
          textBlocks = retry.content.filter((b) => b.type === "text");
          toolBlocks = retryTools;
        }
      } catch (err) {
        console.error("[ai] Retry failed:", err.status, err.message?.substring(0, 200));
      }
    }
  }

  // Fast path: no tools needed, return response directly.
  if (response.stop_reason === "end_turn" || toolBlocks.length === 0) {
    const reply = textBlocks.map((b) => b.text).join("\n");
    console.log("[ai] Direct reply (" + reply.length + " chars, stop=" + response.stop_reason + ")");
    // Record a stayed-silent turn as itself, not as the literal sentinel — the
    // history is fed back as her own past output, so storing "NO_REPLY" teaches
    // her that posting it is normal. For the same reason the marker must not
    // read like something she could send: an earlier prose version, "(stayed
    // silent, nothing to add)", got copied straight into live replies and
    // posted. Keep it obviously machine-written, and isSilenceReply() swallows
    // the mimicry as a backstop.
    history.push({ role: "assistant", content: isSilenceReply(reply) ? SILENT_TURN_MARKER : reply });
    trimHistory(history, channel.id);
    return reply;
  }

  // Model wants to use tools. Switch to background mode.
  const taskKey = "bg-" + Date.now();
  const taskSummary = content.length > 80 ? content.substring(0, 80) + "..." : content;
  registerBackgroundTask(channel.id, taskKey, taskSummary);

  const placeholderContent = "[BACKGROUND TASK " + taskKey + ": Already working on this request in a separate background process. This task is being handled independently. Do not re-address, continue, or reference this request.]";
  history.push({ role: "assistant", content: placeholderContent });
  trimHistory(history, channel.id);

  console.log("[ai] Switched to background (tool_use detected) task " + taskKey + " for channel " + channel.id);

  frozenMessages.push({ role: "assistant", content: response.content });

  startBgWork(channel.id, async () => {
    var pMsg = await channel.send("" + emoji() + " **Working...**").catch(() => null);
    const firstToolResults = [];
    for (const toolCall of toolBlocks) {
      console.log("[ai] Tool call: " + toolCall.name + "(" + JSON.stringify(toolCall.input).substring(0, 200) + ")");
      const result = await Promise.resolve(executeTool(toolCall.name, toolCall.input, getDiscordClient(), "main"));
      firstToolResults.push({
        type: "tool_result",
        tool_use_id: toolCall.id,
        content: toolResultContent(result),
      });
    }

    frozenMessages.push({ role: "user", content: firstToolResults });

    try {
      const result = await runToolLoop(client, frozenMessages, cachedTools, systemBlocks, model, channel, { channelId: channel.id, taskKey }, pMsg);
      unregisterBackgroundTask(channel.id, taskKey);
      if (pMsg) pMsg.delete().catch(function() {});
      await sendBgResult(channel, history, taskKey, result);
    } catch (err) {
      unregisterBackgroundTask(channel.id, taskKey);
      if (pMsg) pMsg.delete().catch(function() {});
      console.error("[ai] Background task error:", err);
      await channel.send("Background task crashed " + emoji() + "").catch(() => {});
    }
  });

  return null;
}

export function clearHistory(channelId) {
  channelHistory.delete(channelId);
  historyLoaded.delete(channelId);
  try { var fp = join(HISTORY_DIR, channelId + ".json"); if (existsSync(fp)) unlinkSync(fp); } catch {}
}

export function compactHistory(channelId) {
  const history = getHistory(channelId);
  if (history.length <= 4) return "Nothing to compact " + emoji() + "";
  const kept = history.slice(-4);
  channelHistory.set(channelId, kept);
  persistHistory(channelId);
  return "Compacted: kept last " + kept.length + " messages, dropped " + (history.length - kept.length) + " " + emoji() + "";
}

export function pruneStaleHistory() {
  const maxAge = 28 * 60 * 60 * 1000;
  const now = Date.now();
  let pruned = 0;
  for (const [channelId, ts] of historyTimestamps) {
    if (now - ts > maxAge) {
      channelHistory.delete(channelId);
      historyLoaded.delete(channelId);
      historyTimestamps.delete(channelId);
      try { var fp = join(HISTORY_DIR, channelId + ".json"); if (existsSync(fp)) unlinkSync(fp); } catch {}
      pruned++;
    }
  }
  if (pruned > 0) console.log("[ai] Pruned " + pruned + " stale channel histories");
}

export { activeBackgroundTasks, channelHistory };
