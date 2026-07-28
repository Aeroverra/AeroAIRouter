import { getDiscordClient } from "./client.js";
import { attachmentName, isImageAttachment, saveAttachment, existingPath, imageBlockFromAttachment, describeAttachment } from "./attachments.js";

// How many of the most recent images to rehydrate as real vision blocks when
// cold-loading channel history from Discord. Older ones stay as text so the
// model knows an image was there without re-downloading the whole backlog.
const MAX_REHYDRATED_IMAGES = 4;

// Download every attachment on a message (dedup'd by attachment id) and describe
// them with their real on-disk paths, so view_image/read_file always hit the file
// that actually belongs to THIS message.
async function saveAttachments(message) {
  if (!message.attachments || message.attachments.size === 0) return "";
  var parts = [];
  for (var entry of message.attachments.values()) {
    try {
      var savePath = await saveAttachment(entry);
      parts.push(describeAttachment(entry, savePath));
    } catch (err) {
      parts.push(attachmentName(entry) + " (failed to download: " + err.message + ", attachment id " + entry.id + ")");
    }
  }
  return " [Attachments: " + parts.join(", ") + "]";
}

// Sync variant: only reports files already on disk, never guesses at a path.
function describeAttachments(message) {
  if (!message.attachments || message.attachments.size === 0) return "";
  var parts = [];
  for (var entry of message.attachments.values()) {
    parts.push(describeAttachment(entry, existingPath(entry)));
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
    // vision blocks (newest first, bounded). Everything else is still pulled down
    // to disk so its description carries a real path the model can view_image.
    const rehydrate = new Map(); // message.id -> [imageBlock, ...]
    let budget = MAX_REHYDRATED_IMAGES;
    for (let i = sorted.length - 1; i >= 0; i--) {
      const m = sorted[i];
      if (m.author.bot && m.author.id === client.user.id) continue;
      if (!m.attachments || m.attachments.size === 0) continue;
      const blocks = [];
      for (const entry of m.attachments.values()) {
        if (budget > 0 && isImageAttachment(entry)) {
          const loaded = await imageBlockFromAttachment(entry);
          if (loaded) { blocks.push(loaded.block); budget--; continue; }
        }
        await saveAttachment(entry).catch((err) => console.error("[history] Failed to save " + attachmentName(entry) + ":", err.message));
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

// Discord IDs are snowflakes that encode a timestamp, so before/after/around can be
// given as either a raw message ID or an ISO date/time — we convert a date to the
// snowflake for that instant.
const DISCORD_EPOCH = 1420070400000n;
function toSnowflake(value) {
  if (!value) return undefined;
  const s = String(value).trim();
  if (/^\d{16,20}$/.test(s)) return s; // already an ID/snowflake
  const ms = Date.parse(s);
  if (Number.isNaN(ms)) return undefined;
  return ((BigInt(ms) - DISCORD_EPOCH) << 22n).toString();
}
const newestFirst = (x, y) => (BigInt(x.id) < BigInt(y.id) ? 1 : BigInt(x.id) > BigInt(y.id) ? -1 : 0);
function msgText(m) {
  return m.content || (m.attachments && m.attachments.size ? "[attachment]" : (m.embeds && m.embeds.length ? "[embed]" : "[no text]"));
}

// Read a window of messages. opts: before/after/around (ID or ISO date), author
// (id/name substring), contains (content substring). before/around let the model
// page into OLD history rather than only the most recent messages.
export async function readChannelMessages(channelId, limit = 25, opts = {}) {
  const client = getDiscordClient();
  if (!client) return "Discord client not ready";
  try {
    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel || !channel.isTextBased()) return "Channel not found or not text-based";

    const q = { limit: Math.min(Math.max(limit, 1), 100) };
    // Discord allows only ONE anchor — prefer around, then before, then after.
    const before = toSnowflake(opts.before), after = toSnowflake(opts.after), around = toSnowflake(opts.around);
    if (around) q.around = around;
    else if (before) q.before = before;
    else if (after) q.after = after;

    const messages = await channel.messages.fetch(q);
    let sorted = [...messages.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);

    if (opts.author) {
      const a = String(opts.author).toLowerCase();
      sorted = sorted.filter((m) => m.author.id === opts.author || (m.author.username || "").toLowerCase().includes(a) || (m.author.displayName || "").toLowerCase().includes(a));
    }
    if (opts.contains) {
      const c = String(opts.contains).toLowerCase();
      sorted = sorted.filter((m) => (m.content || "").toLowerCase().includes(c));
    }
    if (!sorted.length) return (opts.author || opts.contains) ? "No messages matched in that window." : "No messages found.";

    const lines = [];
    for (const m of sorted) {
      const name = m.author.displayName || m.author.username;
      const time = new Date(m.createdTimestamp).toISOString();
      let attachmentInfo = "";
      if (m.attachments && m.attachments.size > 0) attachmentInfo = await saveAttachments(m);
      lines.push("[" + time + "] " + name + " (id " + m.id + "): " + m.content + attachmentInfo);
    }
    return lines.join("\n");
  } catch (err) {
    return "Error reading messages: " + err.message;
  }
}

// Search back through a channel's history (bots can't use Discord's search API, so
// this pages backward and filters locally). opts: query (content substring), author
// (id/name), before/after (ID or ISO bound), maxScan (how far back to look). Returns
// the matches with timestamps.
export async function searchChannelMessages(channelId, opts = {}) {
  const client = getDiscordClient();
  if (!client) return "Discord client not ready";
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel || !channel.isTextBased()) return "Channel not found or not text-based";

  const query = (opts.query || "").toLowerCase().trim();
  const author = (opts.author || "").toLowerCase().trim();
  if (!query && !author) return "Provide a query and/or author to search for.";
  const afterSnow = toSnowflake(opts.after);
  const cap = Math.min(Math.max(opts.maxScan || 300, 1), 1500);

  const matches = [];
  let cursor = toSnowflake(opts.before);
  let scanned = 0, stop = false;
  try {
    while (scanned < cap && !stop) {
      const batch = await channel.messages.fetch({ limit: Math.min(100, cap - scanned), ...(cursor ? { before: cursor } : {}) }).catch(() => null);
      if (!batch || batch.size === 0) break;
      const arr = [...batch.values()].sort(newestFirst); // newest -> oldest
      for (const m of arr) {
        scanned++;
        if (afterSnow && BigInt(m.id) < BigInt(afterSnow)) { stop = true; break; }
        const name = m.author.displayName || m.author.username || "";
        const okAuthor = !author || m.author.id === opts.author || name.toLowerCase().includes(author) || (m.author.username || "").toLowerCase().includes(author);
        const okQuery = !query || (m.content || "").toLowerCase().includes(query);
        if (okAuthor && okQuery) matches.push("[" + new Date(m.createdTimestamp).toISOString() + "] " + name + " (id " + m.id + "): " + msgText(m).slice(0, 300));
      }
      cursor = arr[arr.length - 1].id; // oldest in this batch
      if (batch.size < 100) break; // reached the start of the channel
    }
  } catch (err) {
    return "Error searching messages: " + err.message + (matches.length ? "\n(partial) " + matches.length + " match(es) so far." : "");
  }
  if (!matches.length) return "No messages matched (scanned " + scanned + " back).";
  const shown = matches.slice(0, 60);
  return "Found " + matches.length + " match(es) scanning " + scanned + " messages back" + (matches.length > shown.length ? " (showing " + shown.length + ", refine to narrow)" : "") + ":\n" + shown.join("\n");
}
