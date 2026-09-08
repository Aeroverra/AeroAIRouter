import config from "../config/index.js";

// Request-level reasoning controls, spread into every Messages API call.
//   config.ai.thinking: "adaptive" (default) | "off"
//   config.ai.effort:   "low" | "medium" | "high" (default) | "xhigh" | "max"
// On Opus 4.6+ omitting `thinking` means the model does NOT think at all, which
// is why Azula was guessing IDs and calling things "done" early. Adaptive
// thinking lets the model decide how much to reason per turn; `effort` caps the
// overall thinking + output spend. (`xhigh` needs Opus 4.7 or newer.)
export function reasoningParams() {
  const out = {};
  const t = String((config.ai && config.ai.thinking) || "adaptive").toLowerCase();
  if (t !== "off" && t !== "disabled" && t !== "false") {
    out.thinking = { type: "adaptive" };
  }
  const e = config.ai && config.ai.effort;
  if (e) out.output_config = { effort: String(e).toLowerCase() };
  return out;
}
