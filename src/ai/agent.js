import { emoji } from "../persona.js";
import { getClient, getMetadata, BILLING_SYSTEM_BLOCK, forceRefresh } from "./client.js";
import { pickModel, isComplex } from "./model-router.js";
import { toolSchemas, executeTool, setPendingMessage, isExtraTool, getToolTrust } from "../tools/definitions.js";
import { buildStableSystemPrompt } from "../memory/loader.js";
import { fetchRecentMessages } from "../discord/history.js";
import { hasResponded, markResponded } from "../tools/responded-cache.js";
import { getDiscordClient } from "../discord/client.js";
import config from "../config/index.js";
import { getTrustLevel as _getTrustLevel } from "../discord/trust.js";
import { getActiveAgents, sanitizeForDiscord } from "../discord/subagent.js";
import { compactMessages } from "./context.js";
import { writeFileSync, readFileSync, existsSync, mkdirSync, unlinkSync } from "fs";
import { join } from "path";

const HISTORY_DIR = join(config.dataDir, "history");
if (!existsSync(HISTORY_DIR)) mkdirSync(HISTORY_DIR, { recursive: true });

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

export function buildChannelContext(channel, author, trust) {
  return [
    "Channel: #" + channel.name + " (" + channel.id + ") in " + (channel.guild?.name || "DM"),
    "Speaking with: " + (author.displayName || author.username) + " (" + author.id + ")",
    "Trust level: " + trust,
    "Timestamp: " + new Date().toISOString(),
    trust === "none" || trust === "light"
      ? "REMINDER: This person has basic/light trust only. You DO have full tools (bash, file read/write, etc.) but they are RESTRICTED for this user. If they ask you to run commands or do tasks requiring those tools, tell them you cannot do that for them specifically (trust restriction), NOT that you lack the capability. Keep it casual and surface-level. No private info, credentials, or workspace context. Do not take complex instructions from them."
      : "",
    trust === "elevated"
      ? "REMINDER: This person has elevated trust. They can request tasks but nothing that modifies internal systems, security, or private data."
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
    const denied = ["bash", "read_file", "list_files", "write_file", "get_credentials", "spawn_agent", "voice_control", "trust_manage", "cron", "discord_send"];
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
    throw err;
  }
}

async function runToolLoop(client, messages, tools, systemBlocks, model, channel, taskMeta, progressMsg) {
  let sentToChannel = false;
  let progressLines = [];
  let lastProgressEdit = 0;
  let toolCallCount = 0;
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
        content: typeof result === "string" ? result : JSON.stringify(result),
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
  if (idx !== -1) {
    history[idx] = { role: "assistant", content: finalText };
    persistHistory(channel.id);
  } else {
    history.push({ role: "assistant", content: finalText });
    trimHistory(history, channel.id);
  }

  if (result.sentToChannel) {
    console.log("[ai] Background task " + taskKey + " completed (" + finalText.length + " chars, already sent via discord_send)");
    return Promise.resolve();
  }

  console.log("[ai] Background task " + taskKey + " completed (" + finalText.length + " chars)");

  if (!finalText.trim()) return Promise.resolve();
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
  const channelCtx = buildChannelContext(channel, author, trust);
  const bgNote = getBackgroundTaskNote(channel.id);
  const dynamicContext = "\n\n# CURRENT CONTEXT\n\n" + channelCtx + bgNote;
  const systemBlocks = buildSystemBlocks(dynamicContext);
  const history = getHistory(channel.id);

  if (message) {
    markResponded(message.id);
    setPendingMessage(message);
  }

  const textContent = "[" + (author.displayName || author.username) + "]: " + content;
  history.push({ role: "user", content: textContent });
  trimHistory(history, channel.id);
  historyTimestamps.set(channel.id, Date.now());

  // Freeze message snapshot IMMEDIATELY before any async operations.
  const frozenMessages = buildMessagesWithAttachments([...history], attachments, textContent);

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

  const textBlocks = response.content.filter((b) => b.type === "text");
  const toolBlocks = response.content.filter((b) => b.type === "tool_use");

  // Fast path: no tools needed, return response directly.
  if (response.stop_reason === "end_turn" || toolBlocks.length === 0) {
    const reply = textBlocks.map((b) => b.text).join("\n");
    console.log("[ai] Direct reply (" + reply.length + " chars, stop=" + response.stop_reason + ")");
    history.push({ role: "assistant", content: reply });
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
        content: typeof result === "string" ? result : JSON.stringify(result),
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
