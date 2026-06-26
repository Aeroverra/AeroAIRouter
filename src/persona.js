import config from "./config/index.js";

// The configured signature emoji, as a trailing suffix (" <emoji>") or "" when
// none is set. Keeps Discord output free of any hardcoded server-specific emoji.
export function emojiSuffix() {
  const e = config.persona && config.persona.emoji;
  return e ? " " + e : "";
}

// The configured signature emoji bare (or "" if none).
export function emoji() {
  return (config.persona && config.persona.emoji) || "";
}

// Display name of the owner, from the people map; falls back to "the owner".
export function ownerName() {
  const id = config.discord.ownerId;
  const p = config.discord.people && config.discord.people[id];
  return (p && p.name) || "the owner";
}
