// Rolling per-channel conversation digest.
//
// A channel's live history is capped (trimHistory drops the oldest turns), so a
// question that refers back to something said hours or days ago lands with that
// context already gone — and the reply is vague or wrong. This keeps a running
// summary of the turns that scroll out, persisted per channel and injected back
// into the prompt, so continuity survives the cap. It complements manage_memory
// (durable facts she chooses to save) by preserving the ambient thread.
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import config from "../config/index.js";

const DIGEST_DIR = join(config.dataDir, "history");
const MAX_DIGEST_CHARS = 2000;

function digestPath(channelId) {
  return join(DIGEST_DIR, channelId + ".digest.txt");
}

export function getChannelDigest(channelId) {
  try {
    const p = digestPath(channelId);
    return existsSync(p) ? readFileSync(p, "utf8") : "";
  } catch {
    return "";
  }
}

function saveDigest(channelId, text) {
  try {
    writeFileSync(digestPath(channelId), String(text || "").slice(0, MAX_DIGEST_CHARS), { encoding: "utf8", mode: 0o600 });
  } catch (e) {
    console.log("[ai] digest save failed for " + channelId + ": " + (e.message || e));
  }
}

// Flatten a batch of dropped turns to plain "User:/Azula:" lines, skipping the
// machine markers that would otherwise pollute the summary.
function messagesToText(messages) {
  const parts = [];
  for (const m of messages || []) {
    if (!m) continue;
    let c = "";
    if (typeof m.content === "string") c = m.content;
    else if (Array.isArray(m.content)) c = m.content.filter((b) => b && b.type === "text").map((b) => b.text).join(" ");
    if (!c || !c.trim()) continue;
    if (/BACKGROUND TASK bg-|system log: no message|older tool output compacted|The model refused|Safety-stopped/.test(c)) continue;
    parts.push((m.role === "user" ? "User: " : "Azula: ") + c.replace(/\s+/g, " ").slice(0, 600));
  }
  return parts.join("\n");
}

// Fold a batch of dropped (older) turns into the persisted rolling summary.
// Cheap model, plain system prompt, fire-and-forget from trimHistory.
export async function updateChannelDigest(client, channelId, droppedMessages) {
  try {
    const dropText = messagesToText(droppedMessages);
    if (!dropText.trim()) return;
    const prev = getChannelDigest(channelId);
    const system =
      "You maintain a running summary of a Discord conversation so an assistant keeps continuity after old messages scroll out of its live context. " +
      "Merge the PRIOR SUMMARY with the NEW (older) messages into ONE updated summary. " +
      "Keep durable facts, decisions, ongoing tasks, stated preferences, names, numbers, links and open questions; drop small talk and pleasantries. " +
      "Write terse third-person prose (no bullet lists), most important first, at most ~1500 characters. Output ONLY the summary text.";
    const user =
      "PRIOR SUMMARY:\n" + (prev || "(none yet)") +
      "\n\nNEW OLDER MESSAGES (chronological):\n" + dropText +
      "\n\nUpdated running summary:";
    const r = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 700,
      system,
      messages: [{ role: "user", content: user }],
    });
    const out = r.content.filter((b) => b.type === "text").map((b) => b.text).join(" ").trim();
    if (out) {
      saveDigest(channelId, out);
      console.log("[ai] Updated channel digest for " + channelId + " (" + out.length + " chars)");
    }
  } catch (e) {
    console.log("[ai] digest update failed for " + channelId + ": " + (e.status || e.message));
  }
}
