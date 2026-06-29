const CONTEXT_WINDOW = 1000000;
const CONTEXT_TARGET = 0.45;  // est tokens undercount dense JSON ~1.5x; trigger well below the 1M hard limit

export function estimateTokens(obj) {
  if (typeof obj === "string") return Math.ceil(obj.length / 3.5);
  if (Array.isArray(obj)) {
    var total = 0;
    for (var i = 0; i < obj.length; i++) total += estimateTokens(obj[i]);
    return total;
  }
  if (obj && typeof obj === "object") {
    // A vision block is a fixed ~1k tokens no matter how large its base64 payload
    // is. Do NOT fall through to JSON.stringify(obj) here: a `tool_result` whose
    // content is an image block would otherwise have its entire base64 string
    // counted (100k+ "tokens" per photo), falsely tripping the 750k compaction
    // threshold and shifting real user turns off the front of the conversation.
    if (obj.type === "image") return 1000;
    var total = 0;
    for (var k in obj) total += estimateTokens(obj[k]);
    return total;
  }
  return 1;
}

export function compactMessages(messages) {
  var total = 0;
  for (var i = 0; i < messages.length; i++) total += estimateTokens(messages[i].content);
  var target = Math.floor(CONTEXT_WINDOW * CONTEXT_TARGET);
  if (total <= target) return;

  console.log("[ai] Context at ~" + total + " tokens (target " + target + "), compacting...");

  // Keep the single most-recent message carrying tool_result output intact so the
  // model can still act on the latest tool response (e.g. the current page of a
  // paginated fetch). Everything older is fair game to shrink.
  var lastResultIdx = -1;
  for (var i = messages.length - 1; i >= 0; i--) {
    var m = messages[i];
    if (m && Array.isArray(m.content) && m.content.some(function (b) { return b && b.type === "tool_result"; })) { lastResultIdx = i; break; }
  }

  var compacted = 0;
  var MARK = "[older tool output compacted to save context]";
  // Pass 1: replace large OLD tool_result payloads with a marker, and truncate giant
  // plain-text messages. This reclaims the bulk of tokens (big paginated API
  // responses) WITHOUT dropping any messages, so tool_use/tool_result pairing stays
  // valid and the original request is preserved.
  for (var i = 0; i < messages.length && total > target; i++) {
    if (i === lastResultIdx) continue;
    var msg = messages[i];
    if (msg && Array.isArray(msg.content)) {
      for (var j = 0; j < msg.content.length; j++) {
        var block = msg.content[j];
        if (block && block.type === "tool_result" && block.content !== MARK) {
          var size = estimateTokens(block.content);
          if (size > 150) {
            block.content = MARK;
            var saved = size - estimateTokens(MARK);
            total -= saved; compacted += saved;
          }
        }
      }
    } else if (msg && typeof msg.content === "string" && msg.content.length > 6000) {
      var savedS = estimateTokens(msg.content) - estimateTokens(msg.content.substring(0, 400) + "...[truncated]");
      messages[i] = { role: msg.role, content: msg.content.substring(0, 400) + "...[truncated]" };
      total -= savedS; compacted += savedS;
    }
  }
  if (compacted > 0) {
    console.log("[ai] Compacted ~" + compacted + " tokens from old messages, now ~" + total);
  }

  // Last resort: even after compacting every old tool_result we are still over the
  // target (the most-recent tool output alone is enormous). Drop oldest messages.
  // sanitizeMessageSequence() runs before every send and repairs any tool_use/
  // tool_result pairing this breaks, so the structure stays valid.
  while (total > target && messages.length > 4) {
    var removed = messages.shift();
    total -= estimateTokens(removed.content);
  }
}

// Guarantee a valid message sequence before sending to the API. History trimming
// and compaction (which shift() off the front) can leave a `tool_result` whose
// matching `tool_use` was dropped, or a `tool_use` whose `tool_result` was dropped.
// The API rejects either with a 400 ("unexpected tool_use_id" / "tool_use ids were
// found without tool_result blocks"). This strips the orphans in place and ensures
// the conversation starts on a clean user turn. Returns the number of fixes applied.
export function sanitizeMessageSequence(messages) {
  let fixes = 0;

  // 1. Drop tool_result blocks with no matching tool_use in the previous message.
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (!msg || msg.role !== "user" || !Array.isArray(msg.content)) continue;
    if (!msg.content.some((b) => b && b.type === "tool_result")) continue;
    const prev = messages[i - 1];
    const validIds = new Set();
    if (prev && prev.role === "assistant" && Array.isArray(prev.content)) {
      for (const b of prev.content) if (b && b.type === "tool_use") validIds.add(b.id);
    }
    const kept = msg.content.filter((b) => !(b && b.type === "tool_result") || validIds.has(b.tool_use_id));
    if (kept.length !== msg.content.length) { fixes += msg.content.length - kept.length; msg.content = kept; }
  }

  // 2. Drop tool_use blocks with no matching tool_result in the next message.
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (!msg || msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
    if (!msg.content.some((b) => b && b.type === "tool_use")) continue;
    const next = messages[i + 1];
    const resultIds = new Set();
    if (next && next.role === "user" && Array.isArray(next.content)) {
      for (const b of next.content) if (b && b.type === "tool_result") resultIds.add(b.tool_use_id);
    }
    const kept = msg.content.filter((b) => !(b && b.type === "tool_use") || resultIds.has(b.id));
    if (kept.length !== msg.content.length) { fixes += msg.content.length - kept.length; msg.content = kept; }
  }

  // 3. Remove messages whose content array is now empty.
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && Array.isArray(m.content) && m.content.length === 0) { messages.splice(i, 1); fixes++; }
  }

  // 4. Drop leading non-user turns and leading orphaned tool_result turns so the
  //    conversation always starts on a clean user message. (Real history always has
  //    leading user text, so this stops at the first clean user turn.)
  while (messages.length > 0) {
    const m = messages[0];
    const orphanResult = m.role === "user" && Array.isArray(m.content) && m.content.some((b) => b && b.type === "tool_result");
    if (m.role !== "user" || orphanResult) { messages.shift(); fixes++; continue; }
    break;
  }

  return fixes;
}
