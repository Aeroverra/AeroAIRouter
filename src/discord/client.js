import { emoji } from "../persona.js";
import { Client, GatewayIntentBits, ActivityType } from "discord.js";
import config from "../config/index.js";
import { shouldRespond } from "./router.js";
import { tryCommand } from "./commands.js";
import { handleMessage } from "../ai/agent.js";
import { setupPresenceWatcher, setupJoinWatcher } from "./presence.js";
import { markResponded, hasResponded } from "../tools/responded-cache.js";
import { getThreadToAgent, injectThreadMessage } from "./subagent.js";

let discordClient = null;
const activeTasks = new Set();

function splitMessage(text, maxLen = 2000) {
  if (text.length <= maxLen) return [text];
  const chunks = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }
    let splitAt = remaining.lastIndexOf("\n", maxLen);
    if (splitAt < maxLen / 2) splitAt = remaining.lastIndexOf(" ", maxLen);
    if (splitAt < maxLen / 2) splitAt = maxLen;
    chunks.push(remaining.substring(0, splitAt));
    remaining = remaining.substring(splitAt).trimStart();
  }
  return chunks;
}

import { writeFileSync, mkdirSync, existsSync } from "fs";

const UPLOADS_DIR = "/tmp/discord-uploads";
if (!existsSync(UPLOADS_DIR)) mkdirSync(UPLOADS_DIR, { recursive: true });

const TEXT_EXTENSIONS = /\.(txt|json|js|ts|py|md|csv|xml|html|css|yaml|yml|toml|cfg|ini|log|sh|bash|sql|jsx|tsx|c|cpp|h|rs|go|java|rb|php|env|conf|properties|gradle|makefile|dockerfile)$/i;

async function extractAttachments(message) {
  const blocks = [];
  if (message.attachments.size === 0) return blocks;

  for (const [, attachment] of message.attachments) {
    const isImage = attachment.contentType?.startsWith("image/") ||
      /\.(png|jpg|jpeg|gif|webp)$/i.test(attachment.name || "");
    const isText = attachment.contentType?.startsWith("text/") ||
      TEXT_EXTENSIONS.test(attachment.name || "");

    try {
      if (isImage) {
        const resp = await fetch(attachment.url);
        const buf = Buffer.from(await resp.arrayBuffer());
        var mediaType = (attachment.contentType || "image/png").split(";")[0];
        if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) {
          mediaType = "image/png";
        } else if (buf[0] === 0xFF && buf[1] === 0xD8) {
          mediaType = "image/jpeg";
        } else if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) {
          mediaType = "image/gif";
        } else if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46) {
          mediaType = "image/webp";
        }
        blocks.push({
          type: "image",
          source: {
            type: "base64",
            media_type: mediaType,
            data: buf.toString("base64"),
          },
        });
        console.log("[discord] Attached image: " + attachment.name + " (" + mediaType + ", " + Math.round(buf.length / 1024) + "KB)");
      } else if (isText) {
        const resp = await fetch(attachment.url);
        const text = await resp.text();
        const savePath = UPLOADS_DIR + "/" + Date.now() + "-" + attachment.name;
        writeFileSync(savePath, text, "utf8");
        blocks.push({
          type: "text",
          text: "[UPLOADED FILE: " + attachment.name + " (" + Math.round(text.length / 1024) + "KB) saved to " + savePath + " - use read_file tool to access contents]",
        });
        console.log("[discord] Saved text file: " + attachment.name + " (" + Math.round(text.length / 1024) + "KB) -> " + savePath);
      } else {
        const resp = await fetch(attachment.url);
        const buf = Buffer.from(await resp.arrayBuffer());
        const savePath = UPLOADS_DIR + "/" + Date.now() + "-" + attachment.name;
        writeFileSync(savePath, buf);
        blocks.push({
          type: "text",
          text: "[UPLOADED FILE: " + attachment.name + " (" + (attachment.contentType || "unknown type") + ", " + Math.round(buf.length / 1024) + "KB) saved to " + savePath + " - binary file, use bash to inspect]",
        });
        console.log("[discord] Saved binary file: " + attachment.name + " (" + Math.round(buf.length / 1024) + "KB) -> " + savePath);
      }
    } catch (err) {
      console.error("[discord] Failed to download attachment " + attachment.name + ":", err.message);
    }
  }
  return blocks;
}

async function processMessageInternal(message) {
  const taskId = message.channel.id + ":" + message.id;
  activeTasks.add(taskId);

  try {
    await message.channel.sendTyping();
    const typingInterval = setInterval(() => {
      message.channel.sendTyping().catch(() => {});
    }, 8000);

    const imageBlocks = await extractAttachments(message);

    const reply = await handleMessage(
      message.content,
      message.author.id,
      message.channel,
      message.author,
      message,
      imageBlocks
    );

    clearInterval(typingInterval);
    console.log("[discord] handleMessage returned: " + (reply === null ? "null" : reply === undefined ? "undefined" : "string(" + reply.length + " chars)") + " first50=" + (reply ? JSON.stringify(reply.substring(0, 50)) : "n/a"));
    if (!reply || reply.trim().length === 0) return;

    const chunks = splitMessage(reply);
    console.log("[discord] Sending " + chunks.length + " chunk(s) to Discord");
    for (let i = 0; i < chunks.length; i++) {
      if (i === 0) {
        await message.reply(chunks[i]).catch(console.error);
      } else {
        await message.channel.send(chunks[i]).catch(console.error);
      }
    }
  } catch (err) {
    console.error("[discord] Error handling message:", err);
    await message
      .reply("Something broke on my end " + emoji() + "")
      .catch(() => {});
  } finally {
    activeTasks.delete(taskId);
  }
}

export function processMessage(message) {
  processMessageInternal(message);
}

export function createDiscordClient() {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildPresences,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildVoiceStates,
    ],
  });

  client.once("clientReady", () => {
    console.log("[discord] Logged in as " + client.user.tag);
    client.user.setPresence({
      activities: [
        {
          name: config.discord.activity.text,
          type: ActivityType.Streaming,
          url: config.discord.activity.url,
        },
      ],
      status: "online",
    });
    setupPresenceWatcher(client);
    setupJoinWatcher(client);
  });

  client.on("messageCreate", (message) => {
    if (message.author.id === client.user.id) return;
    if (message.author.bot && !config.discord.people[message.author.id]) return;

    if (message.channel.isThread && message.channel.isThread()) {
      var threadMap = getThreadToAgent();
      if (threadMap.has(message.channel.id)) {
        markResponded(message.id);
        var authorName = message.author.username || "User";
        extractAttachments(message).then(function(imageBlocks) {
          var injected = injectThreadMessage(message.channel.id, message.content, authorName, imageBlocks);
          if (injected) {
            message.channel.sendTyping().catch(function() {});
            console.log("[discord] Routed thread message from " + authorName + " to sub-agent (attachments: " + imageBlocks.length + ")");
          }
        }).catch(function(err) {
          console.error("[discord] Failed to extract thread attachments:", err.message);
          injectThreadMessage(message.channel.id, message.content, authorName, []);
        });
        return;
      }
    }

    if (!shouldRespond(message, client.user.id)) return;
    if (hasResponded(message.id)) return;

    markResponded(message.id);

    const cmdResult = tryCommand(message, config.discord.ownerId);
    if (cmdResult !== null) {
      Promise.resolve(cmdResult).then((r) => {
        if (r) message.reply(r).catch(console.error);
      });
      return;
    }

    processMessage(message);
  });

  discordClient = client;
  return client;
}

export function getDiscordClient() {
  return discordClient;
}

export function getActiveTasks() {
  return activeTasks;
}

export async function startDiscord() {
  const client = createDiscordClient();
  await client.login(config.discord.token);
  return client;
}

export async function stopDiscord() {
  if (discordClient) {
    if (activeTasks.size > 0) {
      console.log("[discord] Waiting for " + activeTasks.size + " active task(s) to finish...");
      const start = Date.now();
      while (activeTasks.size > 0 && Date.now() - start < 60000) {
        await new Promise((r) => setTimeout(r, 500));
      }
      if (activeTasks.size > 0) {
        console.log("[discord] Task wait timeout, forcing shutdown");
      }
    }
    discordClient.destroy();
    discordClient = null;
  }
}
