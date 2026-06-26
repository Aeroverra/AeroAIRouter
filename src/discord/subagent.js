import { emoji } from "../persona.js";
import { getClient, getMetadata, BILLING_SYSTEM_BLOCK, forceRefresh } from "../ai/client.js";
import { toolSchemas, executeTool } from "../tools/definitions.js";
import { buildStableSystemPrompt } from "../memory/loader.js";
import { randomUUID } from "crypto";
import { writeFileSync, readFileSync, readdirSync, mkdirSync, existsSync, unlinkSync } from "fs";
import { join } from "path";
import config from "../config/index.js";
import { compactMessages } from "../ai/context.js";
import { clearAllFileOwners } from "../tools/file-lock.js";
import { emojiSuffix } from "../persona.js";

let enabled = true;
const activeAgents = new Map();
const threadToAgent = new Map();
const AGENTS_DIR = join(config.dataDir, "agents");

if (!existsSync(AGENTS_DIR)) {
  mkdirSync(AGENTS_DIR, { recursive: true });
}

export function setSubagentEnabled(val) { enabled = val; }
export function isSubagentEnabled() { return enabled; }
export function getActiveAgents() { return activeAgents; }
export function getThreadToAgent() { return threadToAgent; }

export function sanitizeForDiscord(text) {
  var cleaned = text.replace(/ghp_[A-Za-z0-9]{36,}/g, "[REDACTED_GITHUB_TOKEN]");
  cleaned = cleaned.replace(/gho_[A-Za-z0-9]{36,}/g, "[REDACTED_GITHUB_TOKEN]");
  cleaned = cleaned.replace(/github_pat_[A-Za-z0-9_]{20,}/g, "[REDACTED_GITHUB_TOKEN]");
  cleaned = cleaned.replace(/glpat-[A-Za-z0-9\-_]{20,}/g, "[REDACTED_GITLAB_TOKEN]");
  cleaned = cleaned.replace(/xox[bpras]-[A-Za-z0-9\-]{10,}/g, "[REDACTED_SLACK_TOKEN]");
  cleaned = cleaned.replace(/sk-[A-Za-z0-9]{20,}/g, "[REDACTED_API_KEY]");
  cleaned = cleaned.replace(/[A-Za-z0-9_\-]{30,}\.[A-Za-z0-9_\-]{6,}\.[A-Za-z0-9_\-]{20,}/g, "[REDACTED_JWT]");
  cleaned = cleaned.replace(/(?:token|key|secret|password|credential|auth|bearer|api.?key|pat)[:\s=]+\S{8,}/gi, "[REDACTED_SECRET]");
  cleaned = cleaned.replace(/[A-Za-z0-9]{32,}(?=[^A-Za-z0-9]|$)/g, function(match) {
    if (/[A-Z]/.test(match) && /[a-z]/.test(match) && /[0-9]/.test(match)) {
      return "[REDACTED_POSSIBLE_SECRET]";
    }
    return match;
  });
  return cleaned;
}

function getSafeSummary(text) {
  var firstLine = text.split("\n")[0];
  var summary = sanitizeForDiscord(firstLine);
  if (summary.length > 150) summary = summary.substring(0, 147) + "...";
  return summary;
}

function getCachedToolsForAgent() {
  return toolSchemas.map(function(t, i) {
    if (i === toolSchemas.length - 1) {
      return Object.assign({}, t, { cache_control: { type: "ephemeral" } });
    }
    return t;
  });
}

function stripImagesFromMessages(messages) {
  return messages.map(function(msg) {
    if (!Array.isArray(msg.content)) return msg;
    var filtered = msg.content.map(function(block) {
      if (block.type === "image") {
        return { type: "text", text: "[image attachment was here, not persisted]" };
      }
      return block;
    });
    return { role: msg.role, content: filtered };
  });
}

function persistAgent(agent) {
  try {
    var state = {
      id: agent.id,
      task: agent.task,
      threadId: agent.threadId,
      model: agent.model,
      status: agent.status,
      startedAt: agent.startedAt,
      lastActivity: agent.lastActivity,
      messages: stripImagesFromMessages(agent.messages),
    };
    writeFileSync(
      join(AGENTS_DIR, agent.id + ".json"),
      JSON.stringify(state),
      { encoding: "utf8", mode: 0o600 }
    );
  } catch (err) {
    console.error("[subagent:" + agent.id + "] Failed to persist:", err.message);
  }
}

function loadPersistedState(agentId) {
  try {
    var filePath = join(AGENTS_DIR, agentId + ".json");
    if (!existsSync(filePath)) return null;
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch (err) {
    console.error("[subagent] Failed to load state for " + agentId + ":", err.message);
    return null;
  }
}

function removePersistedState(agentId) {
  try {
    var filePath = join(AGENTS_DIR, agentId + ".json");
    if (existsSync(filePath)) unlinkSync(filePath);
  } catch {}
}

export function injectThreadMessage(threadId, content, authorName, imageBlocks) {
  var agentId = threadToAgent.get(threadId);
  if (!agentId) return false;
  var agent = activeAgents.get(agentId);
  if (!agent || agent.status !== "running") return false;

  if (!agent.pendingMessages) agent.pendingMessages = [];
  var pending = {
    text: "[" + authorName + " said in thread]: " + content,
    timestamp: Date.now(),
  };
  if (imageBlocks && imageBlocks.length > 0) {
    pending.images = imageBlocks;
  }
  agent.pendingMessages.push(pending);
  console.log("[subagent:" + agentId + "] Injected thread message from " + authorName + " (images: " + (imageBlocks ? imageBlocks.length : 0) + ")");
  return true;
}

export function messageAgent(agentId, content) {
  var agent = activeAgents.get(agentId);
  if (!agent) return { error: "No agent with ID " + agentId + " found." };
  if (agent.status !== "running") return { error: "Agent " + agentId + " is not running (status: " + agent.status + ")." };

  if (!agent.pendingMessages) agent.pendingMessages = [];
  agent.pendingMessages.push({
    text: "[Message from primary agent]: " + content,
    timestamp: Date.now(),
  });
  console.log("[subagent:" + agentId + "] Injected message from primary agent");
  return { success: true, message: "Message delivered to agent " + agentId };
}

export function listAgents() {
  var result = [];
  for (var [id, agent] of activeAgents) {
    result.push({
      id: id,
      task: getSafeSummary(agent.task),
      threadId: agent.threadId,
      status: agent.status,
      runningFor: Math.round((Date.now() - agent.startedAt) / 60000) + " min",
      lastActivity: Math.round((Date.now() - agent.lastActivity) / 60000) + " min ago",
    });
  }
  return result.length > 0 ? result : "No active agents.";
}

export async function spawnSubagent(parentMessage, taskDescription, model) {
  if (!enabled) return "Sub-agents are currently disabled.";

  var safeSummary = getSafeSummary(taskDescription);
  var resolvedModel = model || config.ai.models.complex;
  var channel = parentMessage.channel;
  var thread;
  try {
    thread = await channel.threads.create({
      name: "Task: " + safeSummary.substring(0, 90),
      autoArchiveDuration: 60,
      reason: "Azula sub-agent task",
    });
  } catch (err) {
    console.error("[subagent] Failed to create thread:", err.message);
    return "Failed to create thread: " + err.message;
  }

  var agentId = randomUUID().substring(0, 8);
  var agent = {
    id: agentId,
    task: taskDescription,
    threadId: thread.id,
    model: resolvedModel,
    status: "running",
    startedAt: Date.now(),
    lastActivity: Date.now(),
    messages: [],
    pendingMessages: [],
  };
  activeAgents.set(agentId, agent);
  threadToAgent.set(thread.id, agentId);
  persistAgent(agent);

  await thread.send(
    emoji() + " Sub-agent `" + agentId + "` started on: **" + safeSummary + "** " + emoji()
  );

  runAgent(agent, thread).catch(function(err) {
    console.error("[subagent:" + agentId + "] Fatal:", err.message);
    thread.send("Sub-agent `" + agentId + "` crashed: " + sanitizeForDiscord(err.message.substring(0, 200)) + " " + emoji()).catch(function() {});
    agent.status = "failed";
    clearAllFileOwners(agent.id);
    persistAgent(agent);
    activeAgents.delete(agentId);
    threadToAgent.delete(thread.id);
  });

  return "Spawned sub-agent `" + agentId + "` in thread " + thread.toString();
}

async function runAgent(agent, thread) {
  var client = await getClient();
  var stablePrompt = buildStableSystemPrompt();
  var dynamicContext = "\n\n# CURRENT CONTEXT\n\nYou are a sub-agent working on a specific task.\nTask: " + agent.task + "\nReport your progress in this thread. Be thorough but concise.\nUsers may send messages in this thread. When you see '[User said in thread]' messages, respond to them naturally as part of your workflow.";

  var systemBlocks = [
    BILLING_SYSTEM_BLOCK,
    { type: "text", text: stablePrompt, cache_control: { type: "ephemeral" } },
    { type: "text", text: dynamicContext },
  ].filter(Boolean);

  var tools = getCachedToolsForAgent();

  if (agent.messages.length === 0) {
    agent.messages.push({ role: "user", content: agent.task });
  }

  while (true) {
    if (agent.status === "cancelled") {
      await thread.send("Sub-agent cancelled " + emoji() + "");
      break;
    }

    if (agent.pendingMessages && agent.pendingMessages.length > 0) {
      var injectBlocks = [];
      for (var pi = 0; pi < agent.pendingMessages.length; pi++) {
        injectBlocks.push({ type: "text", text: agent.pendingMessages[pi].text });
        if (agent.pendingMessages[pi].images) {
          for (var ii = 0; ii < agent.pendingMessages[pi].images.length; ii++) {
            injectBlocks.push(agent.pendingMessages[pi].images[ii]);
          }
        }
      }
      var lastMsg = agent.messages[agent.messages.length - 1];
      if (lastMsg && lastMsg.role === "user") {
        if (!Array.isArray(lastMsg.content)) {
          lastMsg.content = [{ type: "text", text: typeof lastMsg.content === "string" ? lastMsg.content : JSON.stringify(lastMsg.content) }];
        }
        for (var ib = 0; ib < injectBlocks.length; ib++) {
          lastMsg.content.push(injectBlocks[ib]);
        }
      } else {
        agent.messages.push({ role: "user", content: injectBlocks });
      }
      agent.pendingMessages = [];
      persistAgent(agent);
    }

    compactMessages(agent.messages);

    for (var mi = 0; mi < agent.messages.length; mi++) {
      var cacheMsg = agent.messages[mi];
      if (cacheMsg.role !== "user") continue;
      if (Array.isArray(cacheMsg.content)) {
        for (var bi = 0; bi < cacheMsg.content.length; bi++) {
          var cacheBlock = cacheMsg.content[bi];
          if (cacheBlock && typeof cacheBlock === "object" && cacheBlock.cache_control) delete cacheBlock.cache_control;
        }
      }
    }
    var cacheLast = agent.messages[agent.messages.length - 1];
    if (cacheLast && cacheLast.role === "user") {
      if (Array.isArray(cacheLast.content) && cacheLast.content.length > 0) {
        var lb = cacheLast.content[cacheLast.content.length - 1];
        if (lb && typeof lb === "object") lb.cache_control = { type: "ephemeral" };
      } else if (typeof cacheLast.content === "string") {
        agent.messages[agent.messages.length - 1] = {
          role: "user",
          content: [{ type: "text", text: cacheLast.content, cache_control: { type: "ephemeral" } }],
        };
      }
    }

    var params = {
      model: agent.model,
      max_tokens: config.ai.maxTokens,
      system: systemBlocks,
      messages: agent.messages,
      tools: tools,
      metadata: getMetadata(),
    };

    var response;
    try {
      var stream = client.messages.stream(params);
      response = await stream.finalMessage();
    } catch (err) {
      if (err.status === 401) {
        console.log("[subagent:" + agent.id + "] Got 401, forcing token refresh and retrying...");
        try {
          await forceRefresh();
          client = await getClient();
          var stream2 = client.messages.stream(params);
          response = await stream2.finalMessage();
        } catch (retryErr) {
          await thread.send("API error after token refresh: " + sanitizeForDiscord((retryErr.message || "unknown").substring(0, 200)) + emojiSuffix()).catch(function() {});
          agent.status = "failed";
          clearAllFileOwners(agent.id);
          persistAgent(agent);
          break;
        }
      } else if (err.status === 429) {
        console.log("[subagent:" + agent.id + "] Rate limited, waiting 30s...");
        await new Promise(function(r) { setTimeout(r, 30000); });
        continue;
      } else {
        await thread.send("API error: " + sanitizeForDiscord((err.message || "unknown").substring(0, 200)) + " " + emoji() + "").catch(function() {});
        agent.status = "failed";
        clearAllFileOwners(agent.id);
        persistAgent(agent);
        break;
      }
    }

    agent.lastActivity = Date.now();

    var textBlocks = response.content.filter(function(b) { return b.type === "text"; });
    var toolBlocks = response.content.filter(function(b) { return b.type === "tool_use"; });

    if (textBlocks.length > 0) {
      var text = sanitizeForDiscord(textBlocks.map(function(b) { return b.text; }).join("\n"));
      if (text.trim()) {
        var chunks = text.match(/[\s\S]{1,1900}/g) || [text];
        for (var ci = 0; ci < chunks.length; ci++) {
          await thread.send(chunks[ci]).catch(function() {});
        }
      }
    }

    if (response.stop_reason === "end_turn" || toolBlocks.length === 0) {
      if (agent.pendingMessages && agent.pendingMessages.length > 0) {
        agent.messages.push({ role: "assistant", content: response.content });
        persistAgent(agent);
        continue;
      }
      agent.status = "completed";
      clearAllFileOwners(agent.id);
      persistAgent(agent);
      await thread.send(
        emoji() + " Sub-agent `" + agent.id + "` finished " + emoji()
      ).catch(function() {});
      break;
    }

    agent.messages.push({ role: "assistant", content: response.content });

    var toolResults = [];
    for (var ti = 0; ti < toolBlocks.length; ti++) {
      var toolCall = toolBlocks[ti];
      console.log("[subagent:" + agent.id + "] Tool: " + toolCall.name + "(" + JSON.stringify(toolCall.input).substring(0, 100) + ")");
      agent.lastActivity = Date.now();
      var result;
      try {
        result = await Promise.resolve(executeTool(toolCall.name, toolCall.input, null, agent.id));
      } catch (err) {
        console.error("[subagent:" + agent.id + "] Tool error (" + toolCall.name + "):", err.message);
        result = { success: false, error: "Tool crashed: " + err.message };
      }
      toolResults.push({
        type: "tool_result",
        tool_use_id: toolCall.id,
        content: typeof result === "string" ? result : JSON.stringify(result),
      });
    }

    agent.messages.push({ role: "user", content: toolResults });
    persistAgent(agent);
  }

  activeAgents.delete(agent.id);
  threadToAgent.delete(agent.threadId);
}

export async function resumePersistedAgents(discordClient) {
  if (!existsSync(AGENTS_DIR)) return;

  var files;
  try {
    files = readdirSync(AGENTS_DIR).filter(function(f) { return f.endsWith(".json"); });
  } catch (err) {
    console.error("[subagent] Failed to read agents dir:", err.message);
    return;
  }

  var resumed = 0;

  for (var fi = 0; fi < files.length; fi++) {
    var agentId = files[fi].replace(".json", "");
    var state = loadPersistedState(agentId);
    if (!state) continue;

    if (state.status !== "running") {
      if (Date.now() - (state.lastActivity || 0) > 24 * 60 * 60 * 1000) {
        removePersistedState(state.id);
        console.log("[subagent] Cleaned up old agent state: " + state.id);
      }
      continue;
    }

    var thread;
    try {
      thread = await discordClient.channels.fetch(state.threadId).catch(function() { return null; });
    } catch (e) {
      thread = null;
    }

    if (!thread) {
      console.log("[subagent] Thread " + state.threadId + " not found for agent " + state.id + ", marking failed");
      state.status = "failed";
      writeFileSync(
        join(AGENTS_DIR, state.id + ".json"),
        JSON.stringify(state),
        { encoding: "utf8", mode: 0o600 }
      );
      continue;
    }

    var agent = {
      id: state.id,
      task: state.task,
      threadId: state.threadId,
      model: state.model,
      status: "running",
      startedAt: state.startedAt,
      lastActivity: Date.now(),
      messages: state.messages || [],
      pendingMessages: [],
    };

    var lastMsgCheck = agent.messages[agent.messages.length - 1];
    if (lastMsgCheck && lastMsgCheck.role === "assistant") {
      var pendingToolUse = [];
      if (Array.isArray(lastMsgCheck.content)) {
        for (var ci = 0; ci < lastMsgCheck.content.length; ci++) {
          if (lastMsgCheck.content[ci].type === "tool_use") {
            pendingToolUse.push(lastMsgCheck.content[ci]);
          }
        }
      }
      if (pendingToolUse.length > 0) {
        var syntheticResults = pendingToolUse.map(function(tu) {
          return {
            type: "tool_result",
            tool_use_id: tu.id,
            content: "Tool execution was interrupted by a restart. Please retry this operation.",
          };
        });
        agent.messages.push({ role: "user", content: syntheticResults });
      }
    }

    activeAgents.set(agent.id, agent);
    threadToAgent.set(agent.threadId, agent.id);

    await thread.send(
      emoji() + " Sub-agent `" + agent.id + "` resuming after restart " + emoji()
    ).catch(function() {});

    console.log("[subagent] Resuming agent " + agent.id + " (" + getSafeSummary(agent.task) + ")");

    runAgent(agent, thread).catch(function(err) {
      console.error("[subagent:" + agent.id + "] Fatal on resume:", err.message);
      thread.send("Sub-agent `" + agent.id + "` crashed after resume: " + sanitizeForDiscord((err.message || "").substring(0, 200)) + " " + emoji()).catch(function() {});
      agent.status = "failed";
      clearAllFileOwners(agent.id);
    persistAgent(agent);
      activeAgents.delete(agent.id);
      threadToAgent.delete(agent.threadId);
    });

    resumed++;
  }

  if (resumed > 0) {
    console.log("[subagent] Resumed " + resumed + " agent(s) after restart");
  } else {
    console.log("[subagent] No agents to resume");
  }
}

export function cancelAgent(agentId) {
  var agent = activeAgents.get(agentId);
  if (!agent) return "No agent with that ID found.";
  agent.status = "cancelled";
  clearAllFileOwners(agent.id);
  persistAgent(agent);
  return "Agent `" + agentId + "` marked for cancellation.";
}
