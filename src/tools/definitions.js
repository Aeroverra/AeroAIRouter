import { exec, execFile, execSync, spawn } from "child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { dirname } from "path";
import { acquireFileLock, getFileOwner } from "./file-lock.js";
import { AttachmentBuilder } from "discord.js";
import { readChannelMessages } from "../discord/history.js";
import { readCredentials } from "./credentials.js";
import { reviewCommand } from "./command-review.js";
import { addTask, listTasks, updateTask, deleteTask } from "./task-queue.js";
import { spawnSubagent, cancelAgent, messageAgent, listAgents } from "../discord/subagent.js";
import { speak, joinVoice, leaveVoice, isInVoice } from "../discord/voice.js";
import { setTrustOverride, clearTrustOverride, getOverrides } from "../discord/trust.js";
import { webSearch, webFetch } from "./web.js";
import { createJob, listJobs, deleteJob, toggleJob } from "./scheduler.js";
import config from "../config/index.js";

let pendingSubagentMessage = null;
export function setPendingMessage(msg) {
  pendingSubagentMessage = msg;
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
    description: "Read recent messages from a Discord channel.",
    input_schema: {
      type: "object",
      properties: {
        channel_id: { type: "string", description: "Discord channel ID" },
        limit: { type: "number", description: "Messages to fetch (default 25, max 50)" },
      },
      required: ["channel_id"],
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
    description: "Fetch a web page or API endpoint and return its content. HTML is stripped to text.",
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
    description: "Send a message to any Discord channel, add a reaction to a message, or upload a file.",
    input_schema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["send", "react", "upload"], description: "Action to take" },
        channel_id: { type: "string", description: "Discord channel ID" },
        content: { type: "string", description: "Message text (for send/upload)" },
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
    name: "cron",
    description: "Schedule recurring or one-time jobs. Jobs fire as agent turns and deliver results to a Discord channel.",
    input_schema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["create", "list", "delete", "enable", "disable"], description: "Action to take" },
        name: { type: "string", description: "Human-readable job name (for create)" },
        type: { type: "string", enum: ["interval", "once"], description: "interval = recurring, once = fire once at a specific time" },
        schedule: { type: "string", description: "For interval: '30m', '6h', '1d'. For once: ISO 8601 timestamp." },
        task: { type: "string", description: "The prompt/task to execute when the job fires (runs as an agent turn)" },
        channel_id: { type: "string", description: "Discord channel to deliver results to" },
        job_id: { type: "string", description: "Job ID (for delete/enable/disable)" },
      },
      required: ["action"],
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
    case "read_discord_messages":
      return readChannelMessages(input.channel_id, Math.min(input.limit || 25, 50));
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

          switch (input.action) {
            case "send": {
              const options = {};
              if (input.content) options.content = input.content;
              if (input.embed) options.embeds = [input.embed];
              if (!options.content && !options.embeds) return { success: false, error: "Provide content or embed" };
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
              await channel.send({ content: input.content || "", files: [attachment] });
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
    case "cron": {
      switch (input.action) {
        case "create": {
          if (!input.name || !input.schedule || !input.task || !input.channel_id) {
            return { success: false, error: "name, schedule, task, and channel_id are required" };
          }
          return createJob(input.name, input.type || "interval", input.schedule, input.task, input.channel_id);
        }
        case "list":
          return { success: true, jobs: listJobs() };
        case "delete": {
          if (!input.job_id) return { success: false, error: "job_id required" };
          return deleteJob(input.job_id);
        }
        case "enable": {
          if (!input.job_id) return { success: false, error: "job_id required" };
          return toggleJob(input.job_id, true);
        }
        case "disable": {
          if (!input.job_id) return { success: false, error: "job_id required" };
          return toggleJob(input.job_id, false);
        }
        default:
          return { error: "Unknown action. Use create, list, delete, enable, or disable." };
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
