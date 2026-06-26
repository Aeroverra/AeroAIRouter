import { getDiscordClient } from "./client.js";
import { writeFileSync, existsSync, readdirSync, mkdirSync } from "fs";

const UPLOADS_DIR = "/tmp/discord-uploads";
if (!existsSync(UPLOADS_DIR)) mkdirSync(UPLOADS_DIR, { recursive: true });

const TEXT_EXTENSIONS = /\.(txt|json|js|ts|py|md|csv|xml|html|css|yaml|yml|toml|cfg|ini|log|sh|bash|sql|jsx|tsx|c|cpp|h|rs|go|java|rb|php|env|conf|properties|gradle|makefile|dockerfile)$/i;

async function saveAttachments(message) {
  if (!message.attachments || message.attachments.size === 0) return "";
  var parts = [];
  for (var entry of message.attachments.values()) {
    var existing = readdirSync(UPLOADS_DIR).find(function(f) {
      return f.endsWith("-" + entry.name);
    });
    if (existing) {
      parts.push(entry.name + " (saved at " + UPLOADS_DIR + "/" + existing + ")");
      continue;
    }
    var isText = (entry.contentType && entry.contentType.startsWith("text/")) ||
      TEXT_EXTENSIONS.test(entry.name || "");
    try {
      var resp = await fetch(entry.url);
      var savePath = UPLOADS_DIR + "/" + Date.now() + "-" + entry.name;
      if (isText) {
        var text = await resp.text();
        writeFileSync(savePath, text, "utf8");
      } else {
        var buf = Buffer.from(await resp.arrayBuffer());
        writeFileSync(savePath, buf);
      }
      parts.push(entry.name + " (saved at " + savePath + ")");
    } catch (err) {
      parts.push(entry.name + " (failed to download: " + err.message + ")");
    }
  }
  return " [Attachments: " + parts.join(", ") + "]";
}

function describeAttachments(message) {
  if (!message.attachments || message.attachments.size === 0) return "";
  var parts = [];
  for (var entry of message.attachments.values()) {
    var existing = readdirSync(UPLOADS_DIR).find(function(f) {
      return f.endsWith("-" + entry.name);
    });
    if (existing) {
      parts.push(entry.name + " (saved at " + UPLOADS_DIR + "/" + existing + ")");
    } else {
      parts.push(entry.name + " (" + (entry.contentType || "unknown") + ", " + Math.round((entry.size || 0) / 1024) + "KB)");
    }
  }
  return " [Attachments: " + parts.join(", ") + "]";
}

export async function fetchRecentMessages(channelId, limit = 15) {
  const client = getDiscordClient();
  if (!client) return [];

  try {
    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel || !channel.isTextBased()) return [];

    const messages = await channel.messages.fetch({ limit });
    const sorted = [...messages.values()].reverse();

    return sorted.map((m) => ({
      role: m.author.bot && m.author.id === client.user.id ? "assistant" : "user",
      content: m.author.bot && m.author.id === client.user.id
        ? m.content
        : "[" + (m.author.displayName || m.author.username) + "]: " + m.content + describeAttachments(m),
      authorId: m.author.id,
      timestamp: m.createdTimestamp,
    }));
  } catch (err) {
    console.error("[history] Failed to fetch messages:", err.message);
    return [];
  }
}

export async function readChannelMessages(channelId, limit = 25) {
  const client = getDiscordClient();
  if (!client) return "Discord client not ready";

  try {
    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel || !channel.isTextBased()) return "Channel not found or not text-based";

    const messages = await channel.messages.fetch({ limit });
    const sorted = [...messages.values()].reverse();

    var lines = [];
    for (var i = 0; i < sorted.length; i++) {
      var m = sorted[i];
      var name = m.author.displayName || m.author.username;
      var time = new Date(m.createdTimestamp).toISOString();
      var attachmentInfo = "";
      if (m.attachments && m.attachments.size > 0) {
        attachmentInfo = await saveAttachments(m);
      }
      lines.push("[" + time + "] " + name + ": " + m.content + attachmentInfo);
    }
    return lines.join("\n");
  } catch (err) {
    return "Error reading messages: " + err.message;
  }
}
