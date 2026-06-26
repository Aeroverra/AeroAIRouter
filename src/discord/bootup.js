import { hasResponded, markResponded } from "../tools/responded-cache.js";
import { shouldRespond, watchedChannelIds } from "./router.js";

export async function bootCatchUp(client, handleMessageFn) {
  console.log("[boot] Checking for missed messages...");

  for (const channelId of watchedChannelIds()) {
    try {
      const channel = await client.channels.fetch(channelId).catch(() => null);
      if (!channel || !channel.isTextBased()) continue;

      const messages = await channel.messages.fetch({ limit: 5 });
      const sorted = [...messages.values()].reverse();
      const lastMsg = sorted[sorted.length - 1];
      if (!lastMsg) continue;
      if (lastMsg.author.id === client.user.id) continue;
      if (hasResponded(lastMsg.id)) continue;

      // Same per-channel rules as live routing.
      if (!shouldRespond(lastMsg, client.user.id)) continue;

      const timeSince = Date.now() - lastMsg.createdTimestamp;
      if (timeSince > 30 * 60 * 1000) {
        console.log(`[boot] Skipping old message in #${channel.name} (${Math.round(timeSince / 60000)}m ago)`);
        continue;
      }

      console.log(`[boot] Responding to missed message in #${channel.name} from ${lastMsg.author.username}`);
      markResponded(lastMsg.id);
      handleMessageFn(lastMsg);
    } catch (err) {
      console.error(`[boot] Error checking channel ${channelId}:`, err.message);
    }
  }

  console.log("[boot] Catch-up complete");
}
