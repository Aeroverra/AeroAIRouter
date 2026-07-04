import { exec, execFile, execSync, spawn } from "child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { dirname } from "path";
import { acquireFileLock, getFileOwner } from "./file-lock.js";
import { AttachmentBuilder } from "discord.js";
import { readChannelMessages, searchChannelMessages } from "../discord/history.js";
import { readCredentials } from "./credentials.js";
import { reviewCommand } from "./command-review.js";
import { addTask, listTasks, updateTask, deleteTask } from "./task-queue.js";
import { spawnSubagent, cancelAgent, messageAgent, listAgents } from "../discord/subagent.js";
import { speak, joinVoice, leaveVoice, isInVoice } from "../discord/voice.js";
import { setTrustOverride, clearTrustOverride, getOverrides } from "../discord/trust.js";
import { webSearch, webFetch } from "./web.js";
// aliased to avoid clashing with task-queue.js's addTask/listTasks/updateTask/deleteTask (a separate TODO list)
import { createTask as createXTask, updateTask as updateXTask, deleteTask as deleteXTask, listTasks as listXTasks, createSchedule, deleteSchedule, listSchedules } from "./task-store.js";
import { runTask } from "./tasks.js";
import { selectMemories, readMemory, writeMemory, appendMemory, deleteMemory, safeMemoryName } from "../memory/store.js";
import { discoverSkills, readSkill, isSkillEnabled } from "../skills/loader.js";
import config from "../config/index.js";

let pendingSubagentMessage = null;
export function setPendingMessage(msg) {
  pendingSubagentMessage = msg;
}
// The channel of the message currently being handled — lets channel-scoped tools
// (read/search messages) default to "here" when no channel_id is given.
function pendingChannelId() {
  return (pendingSubagentMessage && pendingSubagentMessage.channel && pendingSubagentMessage.channel.id) || null;
}

let _blockedChannelId = null;
export function setBlockedChannelId(channelId) {
  _blockedChannelId = channelId;
}

// Plugin- and MCP-registered tools. They push their schema into `toolSchemas`
// (so the model sees them) and register a handler here. Loaded once at startup
// before any message is handled, keeping the `toolSchemas` reference stable for
// caching. `toolTrust` records the minimum trust level required to use each
// registered tool — these reach external services with the operator's
// credentials, so they default to owner-only.
const pluginHandlers = {};
const toolTrust = {};
export function registerTool(schema, handler, opts = {}) {
  if (!schema || !schema.name || typeof handler !== "function") {
    console.error("[tools] registerTool: invalid schema/handler");
    return;
  }
  if (pluginHandlers[schema.name] || toolSchemas.some((t) => t.name === schema.name)) {
    console.error("[tools] registerTool: duplicate tool name '" + schema.name + "' — skipping");
    return;
  }
  toolSchemas.push(schema);
  pluginHandlers[schema.name] = handler;
  toolTrust[schema.name] = opts.trust || "owner";
}

// True for tools added at runtime by a plugin or MCP server (not a built-in).
export function isExtraTool(name) {
  return Object.prototype.hasOwnProperty.call(pluginHandlers, name);
}
export function getToolTrust(name) {
  return toolTrust[name] || "owner";
}

export const toolSchemas = [
  {
    name: "bash",
    description: "Execute a bash command. Dangerous commands are screened by the configured command-review policy first.",
    input_schema: {
      type: "object",
      properties: {
        command: { type: "string", description: "The bash command to execute" },
        timeout: { type: "number", description: "Timeout in ms (default 120000 = 2 min, max 1800000 = 30 min). Pass a larger value only for genuinely long-running commands." },
      },
      required: ["command"],
    },
  },
  {
    name: "read_file",
    description: "Read a file from disk.",
    input_schema: {
      type: "object",
      properties: { path: { type: "string", description: "Absolute path" } },
      required: ["path"],
    },
  },
  {
    name: "view_image",
    description: "Load an image file from disk into your vision so you can actually SEE it. Use this whenever you need to visually analyze, describe, OCR, or answer questions about the contents of an image file (png/jpg/jpeg/gif/webp). The image is returned to you as a real picture, not text. Do NOT claim you cannot see images — use this tool.",
    input_schema: {
      type: "object",
      properties: { path: { type: "string", description: "Absolute path to the image file" } },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description: "Write content to a file. Creates parent dirs if needed.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute path" },
        content: { type: "string", description: "Content to write" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "list_files",
    description: "List files in a directory.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute path" },
        recursive: { type: "boolean", description: "Recurse (default false)" },
      },
      required: ["path"],
    },
  },
  {
    name: "read_discord_messages",
    description: "Read a window of messages from a Discord channel. By default reads the most recent, but pass before/after/around to page into OLDER history (each accepts a message ID or an ISO date like \"2026-05-01\"). author/contains filter the window. To find something specific deep in old history, use search_discord_messages instead.",
    input_schema: {
      type: "object",
      properties: {
        channel_id: { type: "string", description: "Channel ID (defaults to the current channel)" },
        limit: { type: "number", description: "Messages to fetch (default 25, max 100)" },
        before: { type: "string", description: "Only messages before this point — a message ID or ISO date. Use to read older history." },
        after: { type: "string", description: "Only messages after this point — a message ID or ISO date." },
        around: { type: "string", description: "Messages around this point — a message ID or ISO date." },
        author: { type: "string", description: "Filter to an author (id or name substring)." },
        contains: { type: "string", description: "Filter to messages whose text contains this." },
      },
      required: [],
    },
  },
  {
    name: "search_discord_messages",
    description: "Search back through a channel's history for messages matching a keyword and/or author — use this when what you need is OLDER than the recent messages you already have. Pages backward through history (Discord doesn't give bots a real search API), so scanning far back takes a moment; narrow with author/before/after and a specific query. Returns matches with timestamps.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Text to look for in message content (case-insensitive)." },
        author: { type: "string", description: "Restrict to an author (id or name substring)." },
        channel_id: { type: "string", description: "Channel to search (defaults to the current channel)." },
        before: { type: "string", description: "Start searching before this point (message ID or ISO date)." },
        after: { type: "string", description: "Stop searching once older than this point (message ID or ISO date)." },
        max_scan: { type: "number", description: "How many messages back to scan (default 300, max 1500)." },
      },
      required: [],
    },
  },
  {
    name: "get_credentials",
    description: "Look up stored credentials for a service (Cloudflare, Proxmox, GitHub, etc.)",
    input_schema: {
      type: "object",
      properties: {
        service: { type: "string", description: "Service name to search for, or empty for all" },
      },
      required: [],
    },
  },
  {
    name: "task_manage",
    description: "Manage the persistent task queue. Actions: add, list, update, delete.",
    input_schema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["add", "list", "update", "delete"] },
        description: { type: "string", description: "Task description (for add)" },
        task_id: { type: "string", description: "Task ID (for update/delete)" },
        status: { type: "string", enum: ["pending", "in_progress", "completed", "failed"] },
        priority: { type: "string", enum: ["low", "normal", "high", "critical"] },
      },
      required: ["action"],
    },
  },
  {
    name: "spawn_agent",
    description: "Spawn a sub-agent in a Discord thread to work on a task independently.",
    input_schema: {
      type: "object",
      properties: {
        task: { type: "string", description: "Task description for the sub-agent" },
        model: { type: "string", description: "Model to use (defaults to the configured complex model)" },
      },
      required: ["task"],
    },
  },
  {
    name: "cancel_agent",
    description: "Cancel a running sub-agent.",
    input_schema: {
      type: "object",
      properties: { agent_id: { type: "string", description: "Agent ID to cancel" } },
      required: ["agent_id"],
    },
  },
  {
    name: "message_agent",
    description: "Send a message to a running sub-agent. Use this to give instructions, corrections, or additional context to a sub-agent without restarting it.",
    input_schema: {
      type: "object",
      properties: {
        agent_id: { type: "string", description: "Agent ID to message" },
        message: { type: "string", description: "Message content to send to the agent" },
      },
      required: ["agent_id", "message"],
    },
  },
  {
    name: "list_agents",
    description: "List all running sub-agents with their IDs, tasks, and status.",
    input_schema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "voice_speak",
    description: "Speak text in the Discord voice channel via TTS.",
    input_schema: {
      type: "object",
      properties: { text: { type: "string", description: "Text to speak" } },
      required: ["text"],
    },
  },
  {
    name: "trust_manage",
    description: "Grant or revoke temporary elevated tool access for a Discord user. Owner only.",
    input_schema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["grant", "revoke", "list"], description: "Action to take" },
        user_id: { type: "string", description: "Discord user ID (for grant/revoke)" },
        duration_minutes: { type: "number", description: "How long to grant access (default 60, max 480)" },
      },
      required: ["action"],
    },
  },
  {
    name: "voice_control",
    description: "Join or leave the Discord voice channel.",
    input_schema: {
      type: "object",
      properties: { action: { type: "string", enum: ["join", "leave", "status"] } },
      required: ["action"],
    },
  },
  {
    name: "web_search",
    description: "Search the web using Brave Search. Returns titles, URLs, and descriptions.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
        count: { type: "number", description: "Number of results (default 5, max 20)" },
      },
      required: ["query"],
    },
  },
  {
    name: "web_fetch",
    description: "Fetch a web page or API endpoint and return its content. HTML is stripped to text. If the site is anti-bot protected (Cloudflare / JS challenge / 403), this returns blocked:true — then retry the same url with the camoufox__fetch_url tool (a stealth browser) if it's available.",
    input_schema: {
      type: "object",
      properties: {
        url: { type: "string", description: "URL to fetch" },
        max_length: { type: "number", description: "Max characters to return (default 20000)" },
      },
      required: ["url"],
    },
  },
  {
    name: "discord_send",
    description: "Send a message to any Discord channel (optionally as a reply to a specific message — adds a jump-link back to it), add a reaction to a message, or upload a file.",
    input_schema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["send", "react", "upload"], description: "Action to take" },
        channel_id: { type: "string", description: "Discord channel ID" },
        content: { type: "string", description: "Message text (for send/upload)" },
        reply_to: { type: "string", description: "Message ID to reply to (send/upload) — makes it a Discord reply with a jump-link back to that message. Use to resurface a message you found in history." },
        message_id: { type: "string", description: "Message ID (for react)" },
        emoji: { type: "string", description: "Emoji to react with (unicode or custom markup)" },
        file_path: { type: "string", description: "Absolute path to file to upload" },
        embed: {
          type: "object",
          description: "Optional embed object with title, description, color, fields, etc.",
          properties: {
            title: { type: "string" },
            description: { type: "string" },
            color: { type: "number" },
            fields: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  name: { type: "string" },
                  value: { type: "string" },
                  inline: { type: "boolean" },
                },
              },
            },
            url: { type: "string" },
            image: { type: "object", properties: { url: { type: "string" } } },
            thumbnail: { type: "object", properties: { url: { type: "string" } } },
          },
        },
      },
      required: ["action", "channel_id"],
    },
  },
  {
    name: "task",
    description: "Create and run reusable TASKS. A task is a named executable unit that runs either as an 'agent' turn (a prompt you write — it may or may not send a message) or a 'command' (a shell command). Use for anything you'll trigger again or schedule (e.g. 'check OSRS xp and post to #channel only if someone gained'). Actions: create, run, list, update, delete.",
    input_schema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["create", "run", "list", "update", "delete"] },
        name: { type: "string", description: "Task name (create)" },
        description: { type: "string" },
        type: { type: "string", enum: ["agent", "command"], description: "agent = run the body as a prompt; command = run the body as a shell command. Default agent." },
        body: { type: "string", description: "The prompt (agent) or shell command (command) to run" },
        channel_id: { type: "string", description: "Channel for output / agent context" },
        post_output: { type: "boolean", description: "Post the result to the channel (default true). Set false for silent tasks." },
        task_id: { type: "string", description: "Task id (run/update/delete)" },
      },
      required: ["action"],
    },
  },
  {
    name: "schedule",
    description: "Schedule a TASK to run automatically. Recurring uses a 5-field cron expression in UTC (minute hour day-of-month month day-of-week); one-off uses an ISO-8601 UTC timestamp. All times are UTC. Actions: create, list, delete.",
    input_schema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["create", "list", "delete"] },
        task_id: { type: "string", description: "The task to run (create)" },
        kind: { type: "string", enum: ["recurring", "once"], description: "Default recurring." },
        cron: { type: "string", description: "5-field cron in UTC (recurring), e.g. '0 22 * * 1-5' = 22:00 UTC on weekdays" },
        run_at: { type: "string", description: "ISO-8601 UTC timestamp (once)" },
        enabled: { type: "boolean" },
        schedule_id: { type: "string", description: "Schedule id (delete)" },
      },
      required: ["action"],
    },
  },
  {
    name: "manage_memory",
    description: "Your long-term memory: markdown notes that are injected into your system prompt on every future run. SAVE something whenever you learn a durable fact worth remembering (a preference, a decision, how something works, a person). Use one file per topic; name it clearly and date-prefixed (e.g. 2026-07-03-user-prefers-X.md) so recent notes stay in the loaded window. Actions: save (create/overwrite), append (add to an existing note), list (see all + which are currently loaded), read, delete.",
    input_schema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["save", "append", "list", "read", "delete"], description: "What to do" },
        name: { type: "string", description: "Memory file name, e.g. 2026-07-03-topic.md (for save/append/read/delete)" },
        content: { type: "string", description: "Markdown content (for save/append)" },
      },
      required: ["action"],
    },
  },
  {
    name: "use_skill",
    description: "Load the full instructions for one of your available SKILLS (listed with slugs in your system prompt). Call this when a task matches a skill's description, then follow the loaded instructions. Only load a skill when it is relevant.",
    input_schema: {
      type: "object",
      properties: {
        slug: { type: "string", description: "The skill slug shown in the SKILLS section, e.g. \"pdf-report\"" },
      },
      required: ["slug"],
    },
  },
];

// Voice tools are only offered when the voice feature is enabled.
if (!(config.features && config.features.voice)) {
  for (let i = toolSchemas.length - 1; i >= 0; i--) {
    if (toolSchemas[i].name === "voice_speak" || toolSchemas[i].name === "voice_control") {
      toolSchemas.splice(i, 1);
    }
  }
}

// Convert a tool's return value into Anthropic tool_result `content`.
// If the tool produced an image (view_image), return content blocks containing
// a real image so the model can see it; otherwise stringify as before.
export function toolResultContent(result) {
  if (result && typeof result === "object" && result.__imageBlock) {
    return [
      { type: "text", text: result.note || "Image loaded into view." },
      result.__imageBlock,
    ];
  }
  return typeof result === "string" ? result : JSON.stringify(result);
}

export function executeTool(name, input, discordClient, callerAgent) {
  switch (name) {
    case "bash": {
      if (!input.command || typeof input.command !== "string") {
        return { success: false, error: "Missing or invalid command argument" };
      }
      const review = reviewCommand(input.command);
      if (!review.approved) {
        return { success: false, blocked: true, reason: review.reason, reviewer: review.reviewer };
      }
      // Default 2 min so a hung command (infinite loop, or a script/REPL blocking
      // on stdin) self-recovers fast instead of wedging the task for the old 30 min.
      // The model can pass an explicit larger timeout (up to 30 min) for genuinely
      // long jobs. detached:true + process.kill(-pid) kills the whole process group
      // so forked children (python/curl) die too, not just the bash wrapper.
      const timeout = Math.min(input.timeout || 120000, 1800000);
      return new Promise((resolve) => {
        var stdoutChunks = [];
        var stderrChunks = [];
        var timedOut = false;
        var proc = spawn("/bin/bash", ["-c", input.command], { stdio: ["ignore", "pipe", "pipe"], detached: true });
        function killTree(sig) { try { process.kill(-proc.pid, sig); } catch (e) { try { proc.kill(sig); } catch (e2) {} } }
        proc.stdout.on("data", function(chunk) { stdoutChunks.push(chunk); });
        proc.stderr.on("data", function(chunk) { stderrChunks.push(chunk); });
        var hardTimer = null;
        var timer = setTimeout(function() {
          timedOut = true;
          killTree("SIGTERM");
          hardTimer = setTimeout(function() { killTree("SIGKILL"); }, 3000);
        }, timeout);
        proc.on("close", function(code) {
          clearTimeout(timer);
          if (hardTimer) clearTimeout(hardTimer);
          var stdout = Buffer.concat(stdoutChunks).toString("utf8");
          var stderr = Buffer.concat(stderrChunks).toString("utf8");
          if (timedOut) {
            resolve({ success: false, timedOut: true, output: stdout, error: "Command exceeded the " + timeout + "ms timeout and was killed. It almost certainly hung \u2014 an infinite loop, or a script/REPL waiting on stdin. Do NOT blindly re-run the same thing: fix the script so it terminates (bound your loops, read input from a file instead of stdin), or if the work is genuinely long-running pass an explicit larger `timeout` (up to 1800000)." });
          } else if (code !== 0 && code !== null) {
            resolve({ success: false, output: stdout, error: stderr || "Exit code " + code, exitCode: code });
          } else {
            resolve({ success: true, output: stdout });
          }
        });
        proc.on("error", function(err) {
          clearTimeout(timer);
          if (hardTimer) clearTimeout(hardTimer);
          resolve({ success: false, error: err.message, exitCode: -1 });
        });
      });
    }
    case "read_file": {
      try {
        return { success: true, content: readFileSync(input.path, "utf8") };
      } catch (err) {
        return { success: false, error: err.message };
      }
    }
    case "view_image": {
      try {
        const buf = readFileSync(input.path);
        let mediaType = null;
        if (buf[0] === 0xff && buf[1] === 0xd8) mediaType = "image/jpeg";
        else if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) mediaType = "image/png";
        else if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) mediaType = "image/gif";
        else if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46) mediaType = "image/webp";
        if (!mediaType) return { success: false, error: "Not a recognized image (png/jpeg/gif/webp): " + input.path };
        // Anthropic caps images ~5MB after base64; keep raw under ~3.7MB.
        if (buf.length > 3.75 * 1024 * 1024) {
          return { success: false, error: "Image too large (" + Math.round(buf.length / 1024) + "KB). Max ~3.7MB. Resize it first (e.g. `convert in.jpg -resize 1600x1600 out.jpg`) then view the smaller copy." };
        }
        return {
          success: true,
          note: "Image " + input.path + " (" + mediaType + ", " + Math.round(buf.length / 1024) + "KB) loaded below.",
          __imageBlock: { type: "image", source: { type: "base64", media_type: mediaType, data: buf.toString("base64") } },
        };
      } catch (err) {
        return { success: false, error: err.message };
      }
    }
    case "write_file": {
      var owner = getFileOwner(input.path);
      if (owner && callerAgent && owner !== callerAgent) {
        return { success: false, error: "File is currently being edited by agent " + owner + ". Wait for it to finish or use message_agent to coordinate." };
      }
      var agentTag = callerAgent || "main";
      var release = acquireFileLock(input.path, agentTag);
      try {
        const dir = dirname(input.path);
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        writeFileSync(input.path, input.content, "utf8");
        release();
        return { success: true, bytesWritten: input.content.length };
      } catch (err) {
        release();
        return { success: false, error: err.message };
      }
    }
    case "list_files": {
      if (typeof input.path !== "string" || !input.path) {
        return { success: false, error: "Missing or invalid path" };
      }
      // No shell: pass the path as argv so it can't be shell-interpreted.
      const file = input.recursive ? "find" : "ls";
      const args = input.recursive
        ? [input.path, "-maxdepth", "3", "-type", "f"]
        : ["-la", input.path];
      return new Promise((resolve) => {
        execFile(file, args, { encoding: "utf8", timeout: 30000, maxBuffer: 5 * 1024 * 1024 }, (err, stdout) => {
          if (err) resolve({ success: false, error: err.message });
          else resolve({ success: true, output: stdout || "" });
        });
      });
    }
    case "read_discord_messages": {
      const chan = input.channel_id || pendingChannelId();
      if (!chan) return "No channel_id given and no current channel.";
      return readChannelMessages(chan, Math.min(input.limit || 25, 100), {
        before: input.before, after: input.after, around: input.around,
        author: input.author, contains: input.contains,
      });
    }
    case "search_discord_messages": {
      const chan = input.channel_id || pendingChannelId();
      if (!chan) return "No channel_id given and no current channel.";
      return searchChannelMessages(chan, {
        query: input.query, author: input.author,
        before: input.before, after: input.after, maxScan: input.max_scan,
      });
    }
    case "get_credentials":
      return { success: true, content: readCredentials(input.service || "") };
    case "task_manage": {
      switch (input.action) {
        case "add":
          return addTask(input.description || "Untitled task", input.priority || "normal");
        case "list":
          return listTasks(input.status ? { status: input.status } : {});
        case "update":
          return updateTask(input.task_id, { status: input.status }) || { error: "Task not found" };
        case "delete":
          return deleteTask(input.task_id) ? { success: true } : { error: "Task not found" };
        default:
          return { error: "Unknown action" };
      }
    }
    case "spawn_agent": {
      if (!pendingSubagentMessage) return { error: "No message context for thread creation" };
      return spawnSubagent(pendingSubagentMessage, input.task, input.model || config.ai.models.complex);
    }
    case "cancel_agent":
      return cancelAgent(input.agent_id);
    case "message_agent":
      return messageAgent(input.agent_id, input.message);
    case "list_agents":
      return listAgents();
    case "voice_speak":
      return speak(input.text);
    case "trust_manage": {
      switch (input.action) {
        case "grant": {
          if (!input.user_id) return { error: "user_id required" };
          const mins = Math.min(input.duration_minutes || 60, 480);
          setTrustOverride(input.user_id, "elevated", mins);
          return { success: true, message: "Granted elevated trust for " + mins + " minutes" };
        }
        case "revoke": {
          if (!input.user_id) return { error: "user_id required" };
          clearTrustOverride(input.user_id);
          return { success: true, message: "Trust override revoked" };
        }
        case "list":
          return { success: true, overrides: getOverrides() };
        default:
          return { error: "Unknown action" };
      }
    }
    case "voice_control": {
      if (input.action === "join")
        return discordClient ? joinVoice(discordClient) : { error: "No client" };
      if (input.action === "leave") {
        leaveVoice();
        return { success: true };
      }
      if (input.action === "status") return { connected: isInVoice() };
      return { error: "Unknown action" };
    }
    case "web_search":
      return webSearch(input.query, input.count);
    case "web_fetch":
      return webFetch(input.url, input.max_length);
    case "discord_send": {
      if (!discordClient) return { error: "Discord client not available" };
      return (async () => {
        try {
          const channel = await discordClient.channels.fetch(input.channel_id);
          if (!channel) return { success: false, error: "Channel not found" };
          const { sanitizeForDiscord } = await import("../discord/subagent.js");

          switch (input.action) {
            case "send": {
              const options = {};
              if (input.content) options.content = sanitizeForDiscord(input.content);
              if (input.embed) options.embeds = [input.embed];
              if (!options.content && !options.embeds) return { success: false, error: "Provide content or embed" };
              // reply_to makes this a Discord reply — a jump-link back to that message.
              if (input.reply_to) options.reply = { messageReference: input.reply_to, failIfNotExists: false };
              const sent = await channel.send(options);
              return { success: true, message_id: sent.id };
            }
            case "react": {
              if (!input.message_id || !input.emoji) return { success: false, error: "message_id and emoji required" };
              const msg = await channel.messages.fetch(input.message_id);
              await msg.react(input.emoji);
              return { success: true };
            }
            case "upload": {
              if (!input.file_path) return { success: false, error: "file_path required" };
              const attachment = new AttachmentBuilder(input.file_path);
              const opts = { content: input.content ? sanitizeForDiscord(input.content) : "", files: [attachment] };
              if (input.reply_to) opts.reply = { messageReference: input.reply_to, failIfNotExists: false };
              await channel.send(opts);
              return { success: true };
            }
            default:
              return { success: false, error: "Unknown action. Use send, react, or upload." };
          }
        } catch (err) {
          return { success: false, error: err.message };
        }
      })();
    }
    case "task": {
      switch (input.action) {
        case "create": {
          if (!input.name || !input.body) return { success: false, error: "name and body are required" };
          const t = createXTask({ name: input.name, description: input.description, type: input.type, body: input.body, channelId: input.channel_id, postOutput: input.post_output });
          return { success: true, task: { id: t.id, name: t.name, type: t.type } };
        }
        case "run": {
          if (!input.task_id) return { success: false, error: "task_id required" };
          return runTask(input.task_id, { source: "tool" });
        }
        case "list":
          return { success: true, tasks: listXTasks() };
        case "update": {
          if (!input.task_id) return { success: false, error: "task_id required" };
          const patch = {};
          for (const [k, c] of [["name", "name"], ["description", "description"], ["type", "type"], ["body", "body"], ["channelId", "channel_id"], ["postOutput", "post_output"]]) if (input[c] !== undefined) patch[k] = input[c];
          return updateXTask(input.task_id, patch) ? { success: true } : { success: false, error: "task not found" };
        }
        case "delete": {
          if (!input.task_id) return { success: false, error: "task_id required" };
          return deleteXTask(input.task_id) ? { success: true } : { success: false, error: "task not found" };
        }
        default:
          return { error: "Unknown action. Use create, run, list, update, delete." };
      }
    }
    case "schedule": {
      switch (input.action) {
        case "create": {
          if (!input.task_id) return { success: false, error: "task_id required" };
          const kind = input.kind === "once" ? "once" : "recurring";
          if (kind === "once" && !input.run_at) return { success: false, error: "run_at (ISO UTC) required for a once schedule" };
          if (kind === "recurring" && !input.cron) return { success: false, error: "cron (5-field UTC) required for a recurring schedule" };
          const s = createSchedule({ taskId: input.task_id, kind, cron: input.cron, runAt: input.run_at, enabled: input.enabled });
          return { success: true, schedule: { id: s.id, kind: s.kind } };
        }
        case "list":
          return { success: true, schedules: listSchedules() };
        case "delete": {
          if (!input.schedule_id) return { success: false, error: "schedule_id required" };
          return deleteSchedule(input.schedule_id) ? { success: true } : { success: false, error: "schedule not found" };
        }
        default:
          return { error: "Unknown action. Use create, list, delete." };
      }
    }
    case "manage_memory": {
      try {
        switch (input.action) {
          case "list": {
            const { files, usedBytes } = selectMemories();
            return {
              success: true,
              loaded: files.filter((f) => f.loaded).map((f) => f.name),
              skipped: files.filter((f) => !f.loaded).map((f) => ({ name: f.name, reason: f.reason })),
              usedKB: Math.round(usedBytes / 1024),
            };
          }
          case "read":
            if (!input.name) return { success: false, error: "name required" };
            return { success: true, name: safeMemoryName(input.name), content: readMemory(input.name) };
          case "save": {
            if (!input.name) return { success: false, error: "name required" };
            const saved = writeMemory(input.name, input.content || "");
            return { success: true, saved, message: "Saved memory " + saved };
          }
          case "append": {
            if (!input.name) return { success: false, error: "name required" };
            const appended = appendMemory(input.name, input.content || "");
            return { success: true, saved: appended, message: "Appended to " + appended };
          }
          case "delete":
            if (!input.name) return { success: false, error: "name required" };
            deleteMemory(input.name);
            return { success: true, message: "Deleted " + safeMemoryName(input.name) };
          default:
            return { success: false, error: "Unknown action. Use save, append, list, read, or delete." };
        }
      } catch (err) {
        return { success: false, error: err.message };
      }
    }
    case "use_skill": {
      try {
        if (!input.slug) return { success: false, error: "slug required" };
        const all = discoverSkills();
        const meta = all.find((s) => s.slug === input.slug);
        if (!meta) return { success: false, error: "No skill named '" + input.slug + "'. Available: " + all.map((s) => s.slug).join(", ") };
        if (!isSkillEnabled(input.slug, config)) return { success: false, error: "Skill '" + input.slug + "' is disabled." };
        const skill = readSkill(input.slug);
        return { success: true, name: skill.name || input.slug, instructions: skill.body };
      } catch (err) {
        return { success: false, error: err.message };
      }
    }
    default: {
      if (pluginHandlers[name]) {
        return pluginHandlers[name](input, { discordClient, callerAgent });
      }
      return { success: false, error: `Unknown tool: ${name}` };
    }
  }
}
