// Detect when the model has ended its turn by asking permission to keep going
// mid-task (instead of just finishing), or by describing what it has NOT done as
// if that were a result. Both the background tool loop (ai/agent.js) and the
// sub-agent loop (discord/subagent.js) use this to auto-continue instead of
// returning a partial deliverable.
export const MAX_AUTO_CONTINUE = 14;

export const CONTINUE_NUDGE = "Continue and FINISH the task completely right now. You already have everything you need, including any pagination cursor (re-read your working files or the saved tool-output files if you lost track). Do NOT stop to ask permission, do NOT summarize partial progress, do NOT post interim reports with discord_send, do NOT check in — keep calling tools until the full requested deliverable is done (the exact count requested), then output the single final complete result. This is an automated continuation; asking to continue again, or listing what is 'not done yet', is a failure.";

export function looksLikeMidTaskYield(text) {
  if (!text) return false;
  const t = text.toLowerCase();
  const patterns = [
    "want me to continue", "want me to keep", "want me to paginate", "want me to go",
    "should i continue", "shall i continue", "ask me to continue", "do you want me",
    "let me know if you want", "i can continue", "ready to continue", "keep paginating",
    "keep going?", "continue?", "more api call", "more pages", "remaining pages",
    "i didn't get", "didn't get the full", "to hit 100", "the remaining", "i have the pagination",
    "would need", "i can keep", "want me to fetch",
    "want me to finish", "want me to spawn", "want me to keep grinding", "want me to grind",
    "in a follow-up", "follow-up?", "fresh session", "follow-up session", "finish the downloads",
    "what's left to finish", "what's not done", "not done yet", "still needs checking",
    "haven't been downloaded", "hasn't been", "not yet downloaded", "pure mechanical work",
    "not done:", "what's not done", "still need", "still needs", "needs checking", "need to paginate",
    "haven't been fetched", "haven't been compared", "hasn't been fetched", "not yet fetched",
    "yet to be", "remains to be", "what blocked", "exhausted the context", "context window before",
    "i'll finish", "i will finish", "next session", "another agent", "spawn another",
  ];
  return patterns.some((x) => t.includes(x));
}
