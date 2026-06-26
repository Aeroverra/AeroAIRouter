import config from "../config/index.js";

const WATCHED_CHANNELS = new Set([
  config.discord.guilds.home.channels.bot,
  config.discord.guilds.public.channels.general,
  config.discord.guilds.public.channels.bot,
]);

const AZULA_CHANNELS = new Set([
  config.discord.guilds.home.channels.bot,
  config.discord.guilds.public.channels.bot,
]);

const GENERAL_CHANNELS = new Set([
  config.discord.guilds.public.channels.general,
]);

const recentMessages = new Map();

function isDuplicate(authorId, content) {
  const key = `${authorId}:${content.substring(0, 100)}`;
  const now = Date.now();
  const last = recentMessages.get(key);
  if (last && now - last < 3000) return true;
  recentMessages.set(key, now);
  if (recentMessages.size > 200) {
    const cutoff = now - 10000;
    for (const [k, v] of recentMessages) {
      if (v < cutoff) recentMessages.delete(k);
    }
  }
  return false;
}

const ALLOWED_BOTS = new Set(config.discord.allowedBots || []);

export function shouldRespond(message, botId) {
  if (message.author.id === botId) return false;
  if (message.author.bot && !ALLOWED_BOTS.has(message.author.id)) return false;

  const channelId = message.channel.id;
  if (!WATCHED_CHANNELS.has(channelId)) return false;

  const mentioned = message.mentions.users.has(botId);
  const isOwner = message.author.id === config.discord.ownerId;
  const isAzulaChannel = AZULA_CHANNELS.has(channelId);
  const isGeneral = GENERAL_CHANNELS.has(channelId);
  const mentionsOthers = message.mentions.users.size > 0 && !mentioned;
  const isReplyToOther = message.reference && !mentioned;

  if (isDuplicate(message.author.id, message.content)) return false;

  if (isAzulaChannel) return true;

  if (isGeneral) {
    if (mentioned) return true;
    if (mentionsOthers) return false;
    if (isReplyToOther) return false;
    if (isOwner) return true;
    const wakeWord = (config.discord.wakeWord || "").toLowerCase();
    if (wakeWord && message.content.toLowerCase().includes(wakeWord)) return true;
    return false;
  }

  if (mentioned) return true;

  return false;
}

export function isGeneralChannel(channelId) {
  return GENERAL_CHANNELS.has(channelId);
}

export function isAzulaChannel(channelId) {
  return AZULA_CHANNELS.has(channelId);
}
