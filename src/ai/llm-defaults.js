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
  "anthropic-beta": "claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,web-search-2025-03-05",
  "x-app": "cli",
  "user-agent": "claude-cli/2.1.159 (external, sdk-cli)",
};

export const DEFAULT_QUERY = { beta: "true" };

// The value of the x-anthropic-billing-header block (OAuth mode only). client.js
// prepends "x-anthropic-billing-header: ".
export const DEFAULT_BILLING = "cc_version=2.1.159.286; cc_entrypoint=sdk-cli; cch=e2159;";
