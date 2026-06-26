import { runApiHealthCheck, formatHealthReport } from "./api-health-check.js";
import { getAuthMode } from "../ai/client.js";
import config from "../config/index.js";

let discordClient = null;

export function setDiscordClient(client) {
  discordClient = client;
}

export async function runWeeklyCheck() {
  // The check captures the Claude CLI's request headers to detect drift — only
  // meaningful for the OAuth/CLI-impersonation path. No-op in API-key mode.
  if (getAuthMode() !== "oauth") {
    console.log("[health] Skipping weekly CLI-header check (auth mode is not oauth)");
    return null;
  }

  console.log("[health] Running weekly API health check...");

  try {
    const result = await runApiHealthCheck();
    const report = formatHealthReport(result);

    console.log("[health] Check complete:", result.changes.length, "changes");

    if (discordClient) {
      const channel = await discordClient.channels
        .fetch(config.discord.guilds.public.channels.bot)
        .catch(() => null);
      if (channel) {
        await channel.send(report).catch(console.error);
      }
    }

    return report;
  } catch (err) {
    console.error("[health] Check failed:", err.message);
    return `Health check failed: ${err.message}`;
  }
}

export function scheduleWeeklyCheck() {
  const MS_PER_WEEK = 7 * 24 * 60 * 60 * 1000;

  function scheduleNext() {
    const now = new Date();
    const nextSunday = new Date(now);
    nextSunday.setDate(now.getDate() + ((7 - now.getDay()) % 7 || 7));
    nextSunday.setHours(12, 0, 0, 0);

    let delay = nextSunday.getTime() - now.getTime();
    if (delay < 60000) delay += MS_PER_WEEK;

    console.log(`[health] Next check scheduled for ${new Date(now.getTime() + delay).toISOString()}`);

    setTimeout(async () => {
      await runWeeklyCheck();
      scheduleNext();
    }, delay);
  }

  scheduleNext();
}
