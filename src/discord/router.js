import config from "../config/index.js";

// Per-channel response rules. New model: config.discord.channels = [
//   { id, mode: "all" | "addressed" | "off", respondToBots: bool }
// ]. If that's absent, fall back to the legacy home/public guild channels so
// existing configs keep working.
function buildChannelMap() {
  const map = new Map();
  const chans = Array.isArray(config.discord.channels) ? config.discord.channels : null;
  if (chans) {
    for (const c of chans) {
      if (c && c.id) map.set(String(c.id), { mode: c.mode || "addressed", respondToBots: !!c.respondToBots });
    }
    return map;
  }
  const g = config.discord.guilds || {};
  const add = (id, mode) => { if (id) map.set(String(id), { mode, respondToBots: false }); };
  add(g.home && g.home.channels && g.home.channels.bot, "all");
  add(g.public && g.public.channels && g.public.channels.bot, "all");
  add(g.public && g.public.channels && g.public.channels.general, "addressed");
  return map;
}

const CHANNELS = buildChannelMap();
const ALLOWED_BOTS = new Set(config.discord.allowedBots || []);
const recentMessages = new Map();

export function watchedChannelIds() {
  return [...CHANNELS.entries()].filter(([, v]) => v.mode !== "off").map(([id]) => id);
}

function isDuplicate(authorId, content) {
  const key = `${authorId}:${content.substring(0, 100)}`;
  const now = Date.now();
  const last = recentMessages.get(key);
  if (last && now - last < 3000) return true;
  recentMessages.set(key, now);
  if (recentMessages.size > 200) {
    const cutoff = now - 10000;
    for (const [k, v] of recentMessages) if (v < cutoff) recentMessages.delete(k);
  }
  return false;
}

export function shouldRespond(message, botId) {
  if (message.author.id === botId) return false;

  const ch = CHANNELS.get(message.channel.id);
  if (!ch || ch.mode === "off") return false;

  // Bots: only if this channel opts in, or the bot is globally allow-listed.
  if (message.author.bot && !(ch.respondToBots || ALLOWED_BOTS.has(message.author.id))) return false;

  if (isDuplicate(message.author.id, message.content)) return false;

  if (ch.mode === "all") return true;

  // "addressed" mode: reply only when clearly directed at the bot.
  const mentioned = message.mentions.users.has(botId);
  if (mentioned) return true;
  if (message.author.id === config.discord.ownerId) return true;
  if (message.reference && !mentioned) return false; // reply to someone else
  if (message.mentions.users.size > 0 && !mentioned) return false; // addressing others
  const wakeWord = (config.discord.wakeWord || "").toLowerCase();
  if (wakeWord && message.content.toLowerCase().includes(wakeWord)) return true;
  return false;
}
