import config from "../config/index.js";

const runtimeOverrides = new Map();

export function getTrustLevel(authorId) {
  const override = runtimeOverrides.get(authorId);
  if (override && Date.now() < override.expiresAt) {
    return override.trust;
  }
  if (override && Date.now() >= override.expiresAt) {
    runtimeOverrides.delete(authorId);
  }
  const person = config.discord.people[authorId];
  if (!person) return "none";
  return person.trust;
}

export function setTrustOverride(authorId, trust, durationMinutes) {
  const expiresAt = Date.now() + durationMinutes * 60 * 1000;
  runtimeOverrides.set(authorId, { trust, expiresAt });
}

export function clearTrustOverride(authorId) {
  runtimeOverrides.delete(authorId);
}

export function getOverrides() {
  const now = Date.now();
  const active = [];
  for (const [userId, override] of runtimeOverrides) {
    if (now < override.expiresAt) {
      const minsLeft = Math.round((override.expiresAt - now) / 60000);
      active.push({ userId, trust: override.trust, minsLeft });
    }
  }
  return active;
}
