// Gmail plugin. Thin descriptor that launches the bundled, standalone MCP server
// in ./mcp. All logic lives in the env-driven MCP server (see mcp/README.md).
//
// Enabled by default, but it only actually launches once Google OAuth is
// configured (mcp() returns null until the refresh token is set), so it never
// floods the model with always-failing tools.
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dir = dirname(fileURLToPath(import.meta.url));

export const meta = {
  name: "gmail",
  label: "Gmail",
  description: "Read, search, and send email via the Gmail API (Google OAuth).",
};

export const enabledByDefault = true;
export const secrets = ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REFRESH_TOKEN"];
export const defaults = { gmailUser: "me" };

export const configSchema = [
  { secret: "GOOGLE_CLIENT_ID", label: "Google OAuth client ID", type: "secret", help: "From a Google Cloud OAuth client (Desktop app). See plugins/gmail/mcp/README.md." },
  { secret: "GOOGLE_CLIENT_SECRET", label: "Google OAuth client secret", type: "secret" },
  { secret: "GOOGLE_REFRESH_TOKEN", label: "Google refresh token", type: "secret", help: "Run `node scripts/get-google-refresh-token.mjs` once to obtain this." },
  { path: "gmailUser", label: "Mailbox", type: "string", help: "Usually 'me'. Set an address for a delegated mailbox." },
];

// Validate the configured credentials by minting an access token + reading the
// mailbox profile. Used by the Plugins tab "Test connection" button. The UI
// passes a secret accessor (it doesn't load secrets.env into its own env).
export async function checkToken(_token, ctx = {}) {
  const get = (k) => (ctx.secret ? ctx.secret(k) : process.env[k]) || "";
  const id = get("GOOGLE_CLIENT_ID");
  const secret = get("GOOGLE_CLIENT_SECRET");
  const refresh = get("GOOGLE_REFRESH_TOKEN");
  if (!id || !secret || !refresh) return { ok: false, error: "Set client ID, client secret, and refresh token first." };
  try {
    const tr = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: id, client_secret: secret, refresh_token: refresh, grant_type: "refresh_token" }),
      signal: AbortSignal.timeout(8000),
    });
    const td = await tr.json().catch(() => ({}));
    if (!tr.ok || !td.access_token) return { ok: false, error: "Token refresh failed: " + (td.error_description || td.error || ("HTTP " + tr.status)) };
    const user = get("GMAIL_USER") || "me";
    const pr = await fetch("https://gmail.googleapis.com/gmail/v1/users/" + encodeURIComponent(user) + "/profile", {
      headers: { Authorization: "Bearer " + td.access_token }, signal: AbortSignal.timeout(8000),
    });
    const pd = await pr.json().catch(() => ({}));
    if (!pr.ok) return { ok: false, error: "Gmail profile failed: " + ((pd.error && pd.error.message) || ("HTTP " + pr.status)) };
    return { ok: true, identity: pd.emailAddress, scopes: [], details: [{ label: "Messages", value: String(pd.messagesTotal) }, { label: "Threads", value: String(pd.threadsTotal) }] };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

export function mcp(ctx) {
  // Only launch once configured — keeps the model's tool list clean otherwise.
  if (!ctx.secret("GOOGLE_REFRESH_TOKEN") || !ctx.secret("GOOGLE_CLIENT_ID") || !ctx.secret("GOOGLE_CLIENT_SECRET")) {
    return null;
  }
  return {
    transport: "stdio",
    command: process.execPath,
    args: [join(__dir, "mcp", "index.js")],
    trust: "owner",
    env: {
      GOOGLE_CLIENT_ID: ctx.secret("GOOGLE_CLIENT_ID"),
      GOOGLE_CLIENT_SECRET: ctx.secret("GOOGLE_CLIENT_SECRET"),
      GOOGLE_REFRESH_TOKEN: ctx.secret("GOOGLE_REFRESH_TOKEN"),
      GMAIL_USER: (ctx.pluginConfig && ctx.pluginConfig.gmailUser) || "me",
    },
  };
}
