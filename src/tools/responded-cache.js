import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";

const CACHE_FILE = join(import.meta.dirname, "..", "..", "data", "responded-cache.json");
const MAX_ENTRIES = 500;
const MAX_AGE_MS = 48 * 60 * 60 * 1000;

let cache = new Map();

export function loadCache() {
  if (!existsSync(CACHE_FILE)) return;
  try {
    const data = JSON.parse(readFileSync(CACHE_FILE, "utf8"));
    const now = Date.now();
    for (const [id, ts] of Object.entries(data)) {
      if (now - ts < MAX_AGE_MS) {
        cache.set(id, ts);
      }
    }
    console.log(`[cache] Loaded ${cache.size} responded message IDs`);
  } catch {
    console.log("[cache] No existing cache or corrupt, starting fresh");
  }
}

export function saveCache() {
  const obj = Object.fromEntries(cache);
  writeFileSync(CACHE_FILE, JSON.stringify(obj), "utf8");
}

export function hasResponded(messageId) {
  return cache.has(messageId);
}

export function markResponded(messageId) {
  cache.set(messageId, Date.now());
  if (cache.size > MAX_ENTRIES) {
    const sorted = [...cache.entries()].sort((a, b) => a[1] - b[1]);
    cache = new Map(sorted.slice(-MAX_ENTRIES));
  }
  saveCache();
}

export function pruneCache() {
  const now = Date.now();
  for (const [id, ts] of cache) {
    if (now - ts > MAX_AGE_MS) cache.delete(id);
  }
  saveCache();
}
