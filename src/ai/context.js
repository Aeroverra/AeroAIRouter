const CONTEXT_WINDOW = 1000000;
const CONTEXT_TARGET = 0.75;

export function estimateTokens(obj) {
  if (typeof obj === "string") return Math.ceil(obj.length / 4);
  if (Array.isArray(obj)) {
    var total = 0;
    for (var i = 0; i < obj.length; i++) total += estimateTokens(obj[i]);
    return total;
  }
  if (obj && typeof obj === "object") {
    if (obj.type === "image") return 1000;
    return estimateTokens(JSON.stringify(obj));
  }
  return 1;
}

export function compactMessages(messages) {
  var total = 0;
  for (var i = 0; i < messages.length; i++) total += estimateTokens(messages[i].content);
  var target = Math.floor(CONTEXT_WINDOW * CONTEXT_TARGET);
  if (total <= target) return;

  console.log("[ai] Context at ~" + total + " tokens (target " + target + "), compacting...");
  var compacted = 0;
  for (var i = 0; i < messages.length - 4; i++) {
    if (total <= target) break;
    var msg = messages[i];
    if (msg.role === "user" && Array.isArray(msg.content)) {
      for (var j = 0; j < msg.content.length; j++) {
        var block = msg.content[j];
        if (block.type === "tool_result" && typeof block.content === "string" && block.content.length > 500) {
          var saved = estimateTokens(block.content) - estimateTokens("[compacted]");
          block.content = "[compacted]";
          total -= saved;
          compacted += saved;
        }
      }
    }
    if (msg.role === "user" && typeof msg.content === "string" && msg.content.length > 2000) {
      var saved = estimateTokens(msg.content) - estimateTokens(msg.content.substring(0, 200) + "...[compacted]");
      messages[i] = { role: "user", content: msg.content.substring(0, 200) + "...[compacted]" };
      total -= saved;
      compacted += saved;
    }
  }
  if (compacted > 0) {
    console.log("[ai] Compacted ~" + compacted + " tokens from old messages, now ~" + total);
  }
  while (total > target && messages.length > 4) {
    var removed = messages.shift();
    total -= estimateTokens(removed.content);
    if (messages.length > 0 && messages[0].role === "assistant") {
      total -= estimateTokens(messages[0].content);
      messages.shift();
    }
  }
}
