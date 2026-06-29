import { getDiscordClient } from "./client.js";
import { writeFileSync, existsSync, readdirSync, mkdirSync } from "fs";

const UPLOADS_DIR = "/tmp/discord-uploads";
if (!existsSync(UPLOADS_DIR)) mkdirSync(UPLOADS_DIR, { recursive: true });

const TEXT_EXTENSIONS = /\.(txt|json|js|ts|py|md|csv|xml|html|css|yaml|yml|toml|cfg|ini|log|sh|bash|sql|jsx|tsx|c|cpp|h|rs|go|java|rb|php|env|conf|properties|gradle|makefile|dockerfile)$/i;

const IMAGE_EXTENSIONS = /\.(png|jpe?g|gif|webp)$/i;
// How many of the most recent images to rehydrate as real vision blocks when
// cold-loading channel history from Discord. Older ones stay as text so the
// model knows an image was there without re-downloading the whole backlog.
const MAX_REHYDRATED_IMAGES = 4;

function isImageAttachment(entry) {
  return (entry.contentType && entry.contentType.startsWith("image/")) ||
    IMAGE_EXTENSIONS.test(entry.name || "");
}

// Download a Discord image attachment and return an Anthropic image content
// block, or null on failure. Mirrors extractAttachments() in client.js
// (magic-byte sniffing so the media_type is correct even if Discord lies).
async function imageBlockFromAttachment(entry) {
  try {
    const resp = await fetch(entry.url);
    const buf = Buffer.from(await resp.arrayBuffer());
    let mediaType = (entry.contentType || "image/png").split(";")[0];
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) mediaType = "image/png";
    else if (buf[0] === 0xff && buf[1] === 0xd8) mediaType = "image/jpeg";
    else if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) mediaType = "image/gif";
    else if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46) mediaType = "image/webp";
    return {
      type: "image",
      source: { type: "base64", media_type: mediaType, data: buf.toString("base64") },
    };
  } catch (err) {
    console.error("[history] Failed to rehydrate image " + entry.name + ":", err.message);
    return null;
  }
}

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

    // First pass: pick the most recent image attachments to rehydrate as real
    // vision blocks (newest first, bounded). Everything else stays as text.
    const rehydrate = new Map(); // message.id -> [imageBlock, ...]
    let budget = MAX_REHYDRATED_IMAGES;
    for (let i = sorted.length - 1; i >= 0 && budget > 0; i--) {
      const m = sorted[i];
      if (m.author.bot && m.author.id === client.user.id) continue;
      if (!m.attachments || m.attachments.size === 0) continue;
      const blocks = [];
      for (const entry of m.attachments.values()) {
        if (budget <= 0) break;
        if (!isImageAttachment(entry)) continue;
        const block = await imageBlockFromAttachment(entry);
        if (block) { blocks.push(block); budget--; }
      }
      if (blocks.length > 0) rehydrate.set(m.id, blocks);
    }

    return sorted.map((m) => {
      const isSelf = m.author.bot && m.author.id === client.user.id;
      if (isSelf) {
        return { role: "assistant", content: m.content, authorId: m.author.id, timestamp: m.createdTimestamp };
      }
      const text = "[" + (m.author.displayName || m.author.username) + "]: " + m.content + describeAttachments(m);
      const imageBlocks = rehydrate.get(m.id);
      const content = imageBlocks
        ? [...imageBlocks, { type: "text", text }]
        : text;
      return { role: "user", content, authorId: m.author.id, timestamp: m.createdTimestamp };
    });
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
