// Does a new message belong to a request the assistant is still working on in
// this channel ("tell me my fishing xp", then "i mean farming", or someone else
// adding "he means farming"), or is it its own thing?
//
// A follow-up is folded into the reply that is still being worked on, so it
// gets one answer that takes it into account instead of a second, separate
// one. Anything else runs as its own turn, in parallel. Cheap model, short
// timeout, and anything but a clear pick counts as separate, so a slow or
// failed check only costs the plain parallel reply.

const SYSTEM =
  "You route chat messages for a Discord assistant. The assistant is still working on the numbered requests below when a new message comes in. " +
  "Decide whether the new message belongs to one of those requests: it corrects it, clarifies it, changes it, narrows or widens it, adds \"also do X\" to it, " +
  "or tells the assistant to stop or hurry. That includes someone other than the requester doing it (\"he means farming\"). " +
  "Otherwise it is separate: a new question, a comment or joke about something else, or a reply to another person. " +
  "Reply with only the number of the request it belongs to, or NONE.";

// requests: [{ who, text }]. Returns the index of the request the message belongs to, or -1.
export async function pickFollowUp(client, requests, who, message, timeoutMs = 4000) {
  if (!requests.length) return -1;
  try {
    const list = requests.map((r, i) => (i + 1) + ". [" + r.who + "]: " + r.text).join("\n");
    const r = await client.messages.create(
      {
        model: "claude-haiku-4-5-20251001",
        max_tokens: 5,
        system: SYSTEM,
        messages: [{ role: "user", content: "REQUESTS IN PROGRESS:\n" + list + "\n\nNEW MESSAGE from " + who + ":\n" + message }],
      },
      { timeout: timeoutMs, maxRetries: 0 }
    );
    const out = r.content.filter((b) => b.type === "text").map((b) => b.text).join(" ").trim();
    const m = /^\s*(\d+)/.exec(out);
    const idx = m ? Number(m[1]) - 1 : -1;
    return idx >= 0 && idx < requests.length ? idx : -1;
  } catch (e) {
    console.log("[ai] follow-up check failed, answering separately: " + (e.status || "") + " " + String(e.message || e).slice(0, 120));
    return -1;
  }
}
