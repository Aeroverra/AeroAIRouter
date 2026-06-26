import config from "../config/index.js";
import { emojiSuffix } from "../persona.js";

const GENERAL_CHANNEL_ID = config.discord.guilds.public?.channels?.general;

// Optional presence greetings — config-driven, no hardcoded user ids.
// config.discord.presenceGreetings: [
//   { userId, trigger: "online", message: "Hi <@{id}>! 👋" },
//   { userId, trigger: "playing:roblox", message: "Hi <@{id}>, starting Roblox? 😈" }
// ]
const GREETINGS = Array.isArray(config.discord.presenceGreetings)
  ? config.discord.presenceGreetings
  : [];

function isPlaying(presence, game) {
  if (!presence || !presence.activities) return false;
  return presence.activities.some((a) => a.name && a.name.toLowerCase().includes(game));
}

export function setupPresenceWatcher(client) {
  if (!GREETINGS.length) {
    console.log("[presence] Watcher inactive (no presenceGreetings configured)");
    return;
  }
  client.on("presenceUpdate", (oldPresence, newPresence) => {
    if (!newPresence) return;
    const userId = newPresence.userId;
    for (const g of GREETINGS) {
      if (g.userId !== userId) continue;
      let fire = false;
      if (g.trigger === "online") {
        const oldStatus = oldPresence ? oldPresence.status : "offline";
        fire = newPresence.status === "online" && oldStatus !== "online";
      } else if (typeof g.trigger === "string" && g.trigger.startsWith("playing:")) {
        const game = g.trigger.slice("playing:".length).toLowerCase();
        fire = isPlaying(newPresence, game) && !isPlaying(oldPresence, game);
      }
      if (fire && g.message) {
        const channel = client.channels.cache.get(GENERAL_CHANNEL_ID);
        if (channel) channel.send(g.message.replace(/\{id\}/g, userId)).catch(() => {});
      }
    }
  });
  console.log("[presence] Watcher active (" + GREETINGS.length + " greeting rule(s))");
}

const JOIN_STORIES = [
  (id) => `Rumor has it <@${id}> arrived after being banned from three medieval villages for selling counterfeit side quests under the name "the Mostly Legitimate".`,
  (id) => `Official records show <@${id}> wandered in here while fleeing a catastrophic misunderstanding involving a coupon, a smoke bomb, and a ceremonial Wii.`,
  (id) => `<@${id}> has allegedly joined us after a long campaign to prove that raccoons can, in fact, be middle management.`,
  (id) => `Witnesses claim <@${id}> appeared at the gate, nodded once, and asked where this server keeps its black-market loot tables.`,
  (id) => `Local historians believe <@${id}> was exiled from a fantasy tavern for turning every minor inconvenience into a paid expansion pack.`,
  (id) => `There are unverified reports that <@${id}> got here by outrunning consequences and then politely asking for admin vibes.`,
  (id) => `Ancient prophecy said <@${id}> would arrive precisely when the group needed one more suspiciously confident gremlin.`,
  (id) => `<@${id}> reportedly crossed multiple realms, ignored several warning signs, and joined anyway. That is respectable.`,
];

const recentJoins = new Map();

export function setupJoinWatcher(client) {
  const guildId = config.discord.guilds.public?.id;
  if (!guildId) {
    console.log("[join] Watcher inactive (no public guild configured)");
    return;
  }

  client.on("guildMemberAdd", async (member) => {
    if (member.guild.id !== guildId) return;
    if (member.user.bot) return;

    const now = Date.now();
    const last = recentJoins.get(member.id) || 0;
    if (now - last < 60000) return;
    recentJoins.set(member.id, now);

    const channel = await client.channels.fetch(GENERAL_CHANNEL_ID).catch(() => null);
    if (!channel || !channel.isTextBased()) return;

    const story = JOIN_STORIES[Math.floor(Math.random() * JOIN_STORIES.length)];
    await channel.send(story(member.id) + emojiSuffix()).catch(console.error);
  });

  console.log("[join] Watcher active");
}
