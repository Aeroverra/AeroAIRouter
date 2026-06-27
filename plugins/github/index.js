// GitHub plugin. A thin descriptor: it owns the host-side config (UI fields,
// secret wiring) and launches the bundled, standalone MCP server in ./mcp.
// All GitHub logic lives in the MCP server, which is env-driven and works in any
// MCP client without this plugin — see mcp/README.md.
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dir = dirname(fileURLToPath(import.meta.url));

export const meta = {
  name: "github",
  label: "GitHub",
  description: "Create and manage GitHub repositories and issues via the GitHub API.",
};

export const enabledByDefault = true;
// Base secret key; multiple scoped tokens are stored as GITHUB_TOKEN, GITHUB_TOKEN_<SLUG>.
export const secrets = ["GITHUB_TOKEN"];
export const defaults = { defaultVisibility: "private", tokens: [{ label: "default", key: "GITHUB_TOKEN" }] };

export const configSchema = [
  { path: "tokens", type: "tokens", keyPrefix: "GITHUB_TOKEN", label: "GitHub tokens", help: "Add one or more PATs (e.g. a scoped read-only one and a write one). Click Check to see what each can do. Create at github.com/settings/tokens." },
  { path: "defaultVisibility", label: "New repos default to", type: "select", options: ["private", "public"], help: "Visibility used when create_repo doesn't specify one." },
];

// Validate a token and report identity + scopes for the UI.
export async function checkToken(token) {
  try {
    const r = await fetch("https://api.github.com/user", {
      headers: { Authorization: "Bearer " + token, Accept: "application/vnd.github+json", "User-Agent": "aeroairouter", "X-GitHub-Api-Version": "2022-11-28" },
    });
    if (!r.ok) return { ok: false, error: "GitHub rejected the token (HTTP " + r.status + ")" };
    const scopes = (r.headers.get("x-oauth-scopes") || "").split(",").map((s) => s.trim()).filter(Boolean);
    const u = await r.json();
    if (!scopes.length) {
      return { ok: true, identity: u.login, scopes: [], note: "Fine-grained token (per-repo permissions — not enumerable via API)." };
    }
    return { ok: true, identity: u.login, scopes };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// Build the launch spec. Projects every configured token into the server's env;
// the server reads only env vars.
export function mcp(ctx) {
  const vis =
    (ctx.pluginConfig && ctx.pluginConfig.defaultVisibility) ||
    (ctx.config && ctx.config.integrations && ctx.config.integrations.github && ctx.config.integrations.github.defaultVisibility) ||
    "private";
  const defs = (ctx.pluginConfig && Array.isArray(ctx.pluginConfig.tokens) && ctx.pluginConfig.tokens.length)
    ? ctx.pluginConfig.tokens
    : [{ label: "default", key: "GITHUB_TOKEN" }];
  const tokens = {};
  let primary = "";
  for (const t of defs) {
    const v = ctx.secret(t.key);
    if (!v) continue;
    tokens[t.label || t.key] = v;
    if (!primary || t.key === "GITHUB_TOKEN") primary = v;
  }
  return {
    transport: "stdio",
    command: process.execPath,
    args: [join(__dir, "mcp", "index.js")],
    trust: "owner",
    env: {
      GITHUB_TOKEN: primary,
      GITHUB_TOKENS_JSON: JSON.stringify(tokens),
      GITHUB_DEFAULT_VISIBILITY: vis,
    },
  };
}
