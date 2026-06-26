import { compactHistory, clearHistory } from "../ai/agent.js";
import { runWeeklyCheck } from "../tools/weekly-check.js";
import { setTrustOverride, clearTrustOverride, getOverrides } from "./trust.js";
import { emojiSuffix, ownerName } from "../persona.js";

const COMMANDS = {
  "/compact": {
    description: "Compact conversation history for this channel",
    ownerOnly: false,
    handler: (message) => {
      const result = compactHistory(message.channel.id);
      return result;
    },
  },
  "/clear": {
    description: "Clear all conversation history for this channel",
    ownerOnly: true,
    handler: (message) => {
      clearHistory(message.channel.id);
      return "History cleared" + emojiSuffix();
    },
  },
  "/ping": {
    description: "Check if the bot is alive",
    ownerOnly: false,
    handler: () => {
      const uptime = process.uptime();
      const hours = Math.floor(uptime / 3600);
      const mins = Math.floor((uptime % 3600) / 60);
      return `Alive and burning${emojiSuffix()} Uptime: ${hours}h ${mins}m`;
    },
  },
  "/reload": {
    description: "Graceful restart (owner only)",
    ownerOnly: true,
    handler: () => {
      setTimeout(() => process.kill(process.pid, "SIGHUP"), 500);
      return "Restarting..." + emojiSuffix();
    },
  },
  "/healthcheck": {
    description: "Run API health check now (owner only)",
    ownerOnly: true,
    handler: async (message) => {
      await message.reply("Running API health check..." + emojiSuffix());
      const report = await runWeeklyCheck();
      return report || "Health check is not applicable in this auth mode.";
    },
  },
  "/trust": {
    description: "Grant temporary tool access: /trust @user [minutes] (default 60)",
    ownerOnly: true,
    handler: (message) => {
      const mentioned = message.mentions.users.first();
      if (!mentioned) return "Tag someone: `/trust @user [minutes]`" + emojiSuffix();
      const parts = message.content.trim().split(/\s+/);
      const minutes = parseInt(parts[2]) || 60;
      setTrustOverride(mentioned.id, "elevated", minutes);
      return `Granted elevated trust to **${mentioned.displayName || mentioned.username}** for ${minutes} minutes${emojiSuffix()}`;
    },
  },
  "/untrust": {
    description: "Revoke temporary tool access: /untrust @user",
    ownerOnly: true,
    handler: (message) => {
      const mentioned = message.mentions.users.first();
      if (!mentioned) return "Tag someone: `/untrust @user`" + emojiSuffix();
      clearTrustOverride(mentioned.id);
      return `Revoked trust override for **${mentioned.displayName || mentioned.username}**${emojiSuffix()}`;
    },
  },
  "/trustlist": {
    description: "Show active trust overrides",
    ownerOnly: true,
    handler: () => {
      const overrides = getOverrides();
      if (overrides.length === 0) return "No active trust overrides" + emojiSuffix();
      const lines = overrides.map((o) => `<@${o.userId}>: **${o.trust}** (${o.minsLeft}min left)`);
      return lines.join("\n") + emojiSuffix();
    },
  },
};

export function tryCommand(message, ownerId) {
  const content = message.content.trim().toLowerCase();
  const cmdName = content.split(/\s/)[0];

  if (!COMMANDS[cmdName]) return null;

  const cmd = COMMANDS[cmdName];
  if (cmd.ownerOnly && message.author.id !== ownerId) {
    return `Only ${ownerName()} can use that command${emojiSuffix()}`;
  }

  return cmd.handler(message);
}
