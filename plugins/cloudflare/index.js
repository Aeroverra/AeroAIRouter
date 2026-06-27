// Cloudflare plugin. Thin descriptor that launches the bundled, standalone MCP
// server in ./mcp. All logic lives in the env-driven MCP server (see
// mcp/README.md); this file only owns host-side config + secret wiring.
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dir = dirname(fileURLToPath(import.meta.url));

export const meta = {
  name: "cloudflare",
  label: "Cloudflare",
  description: "Manage Cloudflare zones and DNS records via the Cloudflare API.",
};

export const enabledByDefault = true;
export const secrets = ["CLOUDFLARE_TOKEN"];
export const defaults = { accountId: "", tokens: [{ label: "default", key: "CLOUDFLARE_TOKEN" }] };

export const configSchema = [
  { path: "tokens", type: "tokens", keyPrefix: "CLOUDFLARE_TOKEN", label: "Cloudflare API tokens", help: "Add one or more tokens (e.g. read-only and DNS-edit). Click Check to verify each. Create at dash.cloudflare.com → My Profile → API Tokens (Zone:Read + Zone:DNS:Edit)." },
  { path: "accountId", label: "Account ID", type: "string", help: "Optional. Found on any Cloudflare dashboard page sidebar." },
];

export async function checkToken(token) {
  try {
    const r = await fetch("https://api.cloudflare.com/client/v4/user/tokens/verify", {
      headers: { Authorization: "Bearer " + token },
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || d.success === false) {
      const msg = (d.errors && d.errors[0] && d.errors[0].message) || ("HTTP " + r.status);
      return { ok: false, error: msg };
    }
    const id = d.result && d.result.id ? d.result.id.slice(0, 8) + "…" : "token";
    const status = (d.result && d.result.status) || "unknown";
    return { ok: true, identity: id, scopes: ["status: " + status] };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

export function mcp(ctx) {
  const accountId =
    (ctx.pluginConfig && ctx.pluginConfig.accountId) ||
    (ctx.config && ctx.config.integrations && ctx.config.integrations.cloudflare && ctx.config.integrations.cloudflare.accountId) ||
    "";
  const defs = (ctx.pluginConfig && Array.isArray(ctx.pluginConfig.tokens) && ctx.pluginConfig.tokens.length)
    ? ctx.pluginConfig.tokens
    : [{ label: "default", key: "CLOUDFLARE_TOKEN" }];
  let primary = "";
  for (const t of defs) {
    const v = ctx.secret(t.key);
    if (!v) continue;
    if (!primary || t.key === "CLOUDFLARE_TOKEN") primary = v;
  }
  return {
    transport: "stdio",
    command: process.execPath,
    args: [join(__dir, "mcp", "index.js")],
    trust: "owner",
    env: {
      CLOUDFLARE_TOKEN: primary,
      CLOUDFLARE_ACCOUNT_ID: accountId,
    },
  };
}
