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
  "anthropic-beta": "claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,thinking-token-count-2026-05-13,context-management-2025-06-27,prompt-caching-scope-2026-01-05,mid-conversation-system-2026-04-07,advisor-tool-2026-03-01,effort-2025-11-24,extended-cache-ttl-2025-04-11",
  "x-app": "cli",
  "user-agent": "claude-cli/2.1.263 (external, sdk-cli)",
};

export const DEFAULT_QUERY = { beta: "true" };

// The value of the x-anthropic-billing-header block (OAuth mode only). client.js
// prepends "x-anthropic-billing-header: ".
//
// CLI 2.1.263 dropped the per-launch `cch` nonce; the block is now just the
// version + entrypoint (captured 2026-09-08 via api-health-check). Keep
// CC_VERSION in step with the user-agent above: models newer than the claimed
// CLI version are refused with claude_code_version_too_old.
export const CC_VERSION = "2.1.263.fd5";
export const DEFAULT_BILLING = "cc_version=" + CC_VERSION + "; cc_entrypoint=sdk-cli;";
