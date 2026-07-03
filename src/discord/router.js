import config from "../config/index.js";

// Per-channel response rules. config.discord.channels = [
//   { id, mode, respondToOthers, respondToBots }
// ]
//   mode "everything" — see every message; reply only when it has something to add
//   mode "name"       — trigger on the wake word (the bot's name), an @-mention, or a reply
//   mode "mention"    — only an @-mention or a reply to the bot
//   mode "off"        — never respond in this channel
//   respondToOthers: if false (default), only the OWNER's messages can trigger the
//                    bot here — the mode governs the owner alone. Turn on to let the
//                    mode apply to everyone else too.
//   respondToBots:   if false (default), other bots never trigger the bot here.
// Legacy aliases kept so old configs still work: mode "all" -> "everything",
// "addressed" -> "name"; the old respondToOwner field is ignored.
function normalizeMode(m) {
  if (m === "all") return "everything";
  if (m === "addressed") return "name";
  if (m === "everything" || m === "name" || m === "mention" || m === "off") return m;
  return "name";
}

function buildChannelMap() {
  const map = new Map();
  const chans = Array.isArray(config.discord.channels) ? config.discord.channels : null;
  if (chans) {
    for (const c of chans) {
      if (c && c.id) map.set(String(c.id), { mode: normalizeMode(c.mode), respondToOthers: !!c.respondToOthers, respondToBots: !!c.respondToBots });
    }
    return map;
  }
  const g = config.discord.guilds || {};
  const add = (id, mode) => { if (id) map.set(String(id), { mode: normalizeMode(mode), respondToOthers: false, respondToBots: false }); };
  add(g.home && g.home.channels && g.home.channels.bot, "everything");
  add(g.public && g.public.channels && g.public.channels.bot, "everything");
  add(g.public && g.public.channels && g.public.channels.general, "name");
  return map;
}

const CHANNELS = buildChannelMap();
const ALLOWED_BOTS = new Set(config.discord.allowedBots || []);
const recentMessages = new Map();

export function watchedChannelIds() {
  return [...CHANNELS.entries()].filter(([, v]) => v.mode !== "off").map(([id]) => id);
}

// The configured mode for a channel (or null). Lets the agent tell the model when
// a channel is "everything" (ambient) so it stays quiet unless it has something useful.
export function channelMode(channelId) {
  const ch = CHANNELS.get(String(channelId));
  return ch ? ch.mode : null;
}

function isDuplicate(authorId, content) {
  const key = `${authorId}:${(content || "").substring(0, 100)}`;
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

function matchesMode(ch, message, botId) {
  if (ch.mode === "everything") return true; // the model decides whether to actually reply

  const mentioned = message.mentions.users.has(botId);
  const repliedUser = message.mentions.repliedUser;
  const repliedToBot = (repliedUser && repliedUser.id === botId) || (!!message.reference && mentioned);

  if (ch.mode === "mention") return mentioned || repliedToBot;

  // "name" mode: the wake word, an @-mention, or a reply to the bot.
  if (mentioned || repliedToBot) return true;
  if (message.reference) return false; // a reply, but not to the bot
  if (message.mentions.users.size > 0 && !mentioned) return false; // addressing someone else
  const wakeWord = (config.discord.wakeWord || "").toLowerCase();
  if (wakeWord && (message.content || "").toLowerCase().includes(wakeWord)) return true;
  return false;
}

export function shouldRespond(message, botId) {
  if (message.author.id === botId) return false;

  const ch = CHANNELS.get(message.channel.id);
  if (!ch || ch.mode === "off") return false;

  if (isDuplicate(message.author.id, message.content)) return false;

  const isOwner = message.author.id === config.discord.ownerId;
  if (message.author.bot) {
    // Bots trigger only if this channel opts in, or the bot is globally allow-listed.
    if (!(ch.respondToBots || ALLOWED_BOTS.has(message.author.id))) return false;
  } else if (!isOwner) {
    // Non-owner humans trigger only if this channel opts in.
    if (!ch.respondToOthers) return false;
  }
  // The owner always reaches here; others/bots only if their toggle is on. Now the
  // channel mode decides whether this specific message actually triggers a reply.
  return matchesMode(ch, message, botId);
}
