// Default request customization for the LLM providers. Kept in its own module
// (no side effects) so both the bot (src/ai/client.js) and the config-UI server
// (src/ui/server.js) can import the defaults without pulling in client.js's auth
// side effects. The UI's "Restore defaults" mirrors these values.
//
// These are the headers/query that impersonate the Claude Code CLI in OAuth mode.
// NB: x-claude-code-session-id is added dynamically per process by client.js and
// is intentionally NOT listed here (it's not user-editable).

export const DEFAULT_HEADERS = {
  "anthropic-dangerous-direct-browser-access": "true",
  "anthropic-beta": "claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,thinking-token-count-2026-05-13,context-management-2025-06-27,prompt-caching-scope-2026-01-05,advisor-tool-2026-03-01,effort-2025-11-24,extended-cache-ttl-2025-04-11",
  "x-app": "cli",
  "user-agent": "claude-cli/2.1.159 (external, sdk-cli)",
};

export const DEFAULT_QUERY = { beta: "true" };

// The value of the x-anthropic-billing-header block (OAuth mode only). client.js
// prepends "x-anthropic-billing-header: ".
//
// `cch` is a nonce, not a version: the real CLI emits a fresh 5-hex value on
// every launch (verified by capturing three consecutive invocations). So it is
// generated per process here rather than hardcoded — pasting a captured one into
// source is meaningless churn, and the weekly header check used to demand
// exactly that every single week.
export const CC_VERSION = "2.1.159.286";
const cch = Math.floor(Math.random() * 0x100000).toString(16).padStart(5, "0");
export const DEFAULT_BILLING = "cc_version=" + CC_VERSION + "; cc_entrypoint=sdk-cli; cch=" + cch + ";";
