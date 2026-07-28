import { writeFileSync, readFileSync, readdirSync, existsSync, mkdirSync } from "fs";

// Shared attachment handling for both the live message path (client.js) and the
// history/tool path (history.js). These used to be two near-identical copies and
// they drifted, which is how images got mixed up.
export const UPLOADS_DIR = "/tmp/discord-uploads";
if (!existsSync(UPLOADS_DIR)) mkdirSync(UPLOADS_DIR, { recursive: true });

export const TEXT_EXTENSIONS = /\.(txt|json|js|ts|py|md|csv|xml|html|css|yaml|yml|toml|cfg|ini|log|sh|bash|sql|jsx|tsx|c|cpp|h|rs|go|java|rb|php|env|conf|properties|gradle|makefile|dockerfile)$/i;
export const IMAGE_EXTENSIONS = /\.(png|jpe?g|gif|webp)$/i;

// Spoilered uploads arrive as SPOILER_<name>, so strip the marker before any
// extension/type sniffing and keep the flag separately.
// (discord.js exposes `name`; the raw REST payload calls it `filename`.)
export function attachmentName(entry) {
  return String(entry.name || entry.filename || "file").replace(/^SPOILER_/, "");
}

export function isSpoiler(entry) {
  return Boolean(entry.spoiler) || /^SPOILER_/.test(String(entry.name || entry.filename || ""));
}

export function isImageAttachment(entry) {
  return (entry.contentType && entry.contentType.startsWith("image/")) ||
    IMAGE_EXTENSIONS.test(attachmentName(entry));
}

export function isTextAttachment(entry) {
  return (entry.contentType && entry.contentType.startsWith("text/")) ||
    TEXT_EXTENSIONS.test(attachmentName(entry));
}

// Discord lies about content types often enough that the media_type has to come
// from the bytes, not the header.
export function sniffMediaType(buf, fallback) {
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "image/png";
  if (buf[0] === 0xff && buf[1] === 0xd8) return "image/jpeg";
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return "image/gif";
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46) return "image/webp";
  return (fallback || "image/png").split(";")[0];
}

// EVERY pasted screenshot is called "image.png", so the on-disk name is keyed by
// the attachment's snowflake id, never by its filename. Keying by filename made
// every later image.png resolve to the FIRST one ever saved, which meant the model
// was shown a stale, unrelated picture and had no way to know.
function diskName(entry) {
  const safe = attachmentName(entry).replace(/[^A-Za-z0-9._-]/g, "_").slice(-80);
  return entry.id + "-" + (safe || "file");
}

export function existingPath(entry) {
  const prefix = entry.id + "-";
  const hit = readdirSync(UPLOADS_DIR).find((f) => f.startsWith(prefix));
  return hit ? UPLOADS_DIR + "/" + hit : null;
}

// Download once, reuse forever. Returns the absolute path on disk.
export async function saveAttachment(entry) {
  const already = existingPath(entry);
  if (already) return already;
  const resp = await fetch(entry.url);
  if (!resp.ok) throw new Error("HTTP " + resp.status + " fetching " + attachmentName(entry));
  const savePath = UPLOADS_DIR + "/" + diskName(entry);
  if (isTextAttachment(entry)) writeFileSync(savePath, await resp.text(), "utf8");
  else writeFileSync(savePath, Buffer.from(await resp.arrayBuffer()));
  return savePath;
}

// Save an image and hand back a real Anthropic vision block for it, plus the path
// so the model can re-view the exact same file later with view_image.
export async function imageBlockFromAttachment(entry) {
  try {
    const path = await saveAttachment(entry);
    const buf = readFileSync(path);
    // Anthropic caps images ~5MB after base64; keep raw under ~3.7MB.
    if (buf.length > 3.75 * 1024 * 1024) {
      console.error("[attachments] Image too large to inline: " + path + " (" + Math.round(buf.length / 1024) + "KB)");
      return null;
    }
    return {
      path,
      block: {
        type: "image",
        source: { type: "base64", media_type: sniffMediaType(buf, entry.contentType), data: buf.toString("base64") },
      },
    };
  } catch (err) {
    console.error("[attachments] Failed to load image " + attachmentName(entry) + ":", err.message);
    return null;
  }
}

// One-line description of an attachment for the text side of a message. Always
// carries the attachment id so a wrong/missing file is obvious instead of silently
// resolving to somebody else's screenshot.
export function describeAttachment(entry, path) {
  const bits = [attachmentName(entry)];
  if (isSpoiler(entry)) bits.push("spoiler");
  if (path) bits.push("saved at " + path);
  else bits.push((entry.contentType || "unknown") + ", " + Math.round((entry.size || 0) / 1024) + "KB, not downloaded");
  bits.push("attachment id " + entry.id);
  return bits[0] + " (" + bits.slice(1).join(", ") + ")";
}
