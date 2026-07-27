// "Say nothing" detection.
//
// Silence is expressed by returning an empty reply, but models are strongly
// disinclined to emit an empty message — asked to stay quiet they instead write
// a sentinel like NO_REPLY, which then gets posted to the channel verbatim and
// looks broken. So the sentinel is a supported protocol now: a reply that is
// nothing but a silence marker means stay silent.
//
// Deliberately strict — it must be the ENTIRE reply (short, no real content
// alongside it), so a message that happens to talk about not replying is never
// swallowed.
// Only machine-looking markers: a bare "pass", "skip" or "no comment" is
// something she might genuinely say to a person, so those are NOT sentinels.
const SILENCE_RE = /^(no[_\s-]?reply|no[_\s-]?response|do[_\s-]?not[_\s-]?reply|stay[_\s-]?silent|silence)$/i;

export function isSilenceReply(text) {
  if (!text) return true;
  let t = String(text).trim();
  if (!t) return true;
  if (t.length > 40) return false;
  // Strip Discord custom emoji (<:name:id>), unicode emoji/symbols, markdown
  // emphasis, code fences/ticks, brackets, quotes and trailing punctuation, so
  // "**[NO_REPLY]** :bluefire:" still reads as the bare sentinel.
  t = t.replace(/<a?:\w+:\d+>/g, "");
  t = t.replace(/:[a-z0-9_]+:/gi, "");
  t = t.replace(/[\p{Extended_Pictographic}\p{Emoji_Presentation}]/gu, "");
  t = t.replace(/[`*_~>#]/g, "");
  t = t.replace(/^[\s(\[{"']+|[\s)\]}"'.!…]+$/g, "");
  t = t.trim();
  if (!t) return true;
  return SILENCE_RE.test(t);
}
