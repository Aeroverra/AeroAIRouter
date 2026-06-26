import config from "../config/index.js";
import { hasResponded, markResponded } from "../tools/responded-cache.js";

const CHANNELS_TO_CHECK = [
  config.discord.guilds.home.channels.bot,
  config.discord.guilds.public.channels.bot,
  config.discord.guilds.public.channels.general,
];

export async function bootCatchUp(client, handleMessageFn) {
  console.log("[boot] Checking for missed messages...");

  for (const channelId of CHANNELS_TO_CHECK) {
    try {
      const channel = await client.channels.fetch(channelId).catch(() => null);
      if (!channel || !channel.isTextBased()) continue;

      const messages = await channel.messages.fetch({ limit: 5 });
      const sorted = [...messages.values()].reverse();

      const lastMsg = sorted[sorted.length - 1];
      if (!lastMsg) continue;

      if (lastMsg.author.id === client.user.id) continue;
      if (hasResponded(lastMsg.id)) continue;

      const isOwner = lastMsg.author.id === config.discord.ownerId;
      const mentionsBot = lastMsg.mentions.users.has(client.user.id);
      const mentionsOthers = lastMsg.mentions.users.size > 0 && !mentionsBot;
      const isReplyToOther = lastMsg.reference && !mentionsBot;
      const isAzulaChannel =
        channelId === config.discord.guilds.home.channels.bot ||
        channelId === config.discord.guilds.public.channels.bot;

      if (mentionsOthers || isReplyToOther) continue;
      if (isOwner || mentionsBot || isAzulaChannel) {
        const timeSince = Date.now() - lastMsg.createdTimestamp;
        if (timeSince > 30 * 60 * 1000) {
          console.log(`[boot] Skipping old message in #${channel.name} (${Math.round(timeSince / 60000)}m ago)`);
          continue;
        }

        console.log(`[boot] Responding to missed message in #${channel.name} from ${lastMsg.author.username}`);
        markResponded(lastMsg.id);

        handleMessageFn(lastMsg);
      }
    } catch (err) {
      console.error(`[boot] Error checking channel ${channelId}:`, err.message);
    }
  }

  console.log("[boot] Catch-up complete");
}
