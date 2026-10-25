// Is a new message part of a request the same person already has in progress
// ("tell me my fishing xp", then "i mean farming"), or its own thing?
//
// A follow-up is folded into the reply that is still being worked on, so it
// gets one answer that takes it into account instead of a second, separate
// one. Anything else runs as its own turn, in parallel. Cheap model, short
// timeout, and anything but a clear yes counts as separate, so a slow or
// failed check only costs the plain parallel reply.

const SYSTEM =
  "You route chat messages for a Discord assistant. Someone asked the assistant for something and it is still working on the answer. " +
  "Then the same person sent a new message. Decide whether the new message belongs to that request: it corrects it, clarifies it, changes it, " +
  "narrows or widens it, adds \"also do X\" to it, or tells the assistant to stop or hurry. Or whether it is a separate thing: a new unrelated question, " +
  "a comment or joke about something else, or a reply to another person. Reply with exactly one word: FOLLOW_UP or SEPARATE.";

export async function isFollowUp(client, request, message, timeoutMs = 4000) {
  try {
    const r = await client.messages.create(
      {
        model: "claude-haiku-4-5-20251001",
        max_tokens: 5,
        system: SYSTEM,
        messages: [{ role: "user", content: "REQUEST IN PROGRESS:\n" + request + "\n\nNEW MESSAGE:\n" + message }],
      },
      { timeout: timeoutMs, maxRetries: 0 }
    );
    const out = r.content.filter((b) => b.type === "text").map((b) => b.text).join(" ").trim();
    return /^FOLLOW/i.test(out);
  } catch (e) {
    console.log("[ai] follow-up check failed, answering separately: " + (e.status || "") + " " + String(e.message || e).slice(0, 120));
    return false;
  }
}
