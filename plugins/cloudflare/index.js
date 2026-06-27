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
  const API = "https://api.cloudflare.com/client/v4";
  const headers = { Authorization: "Bearer " + token };
  const get = async (path) => {
    const r = await fetch(API + path, { headers, signal: AbortSignal.timeout(8000) });
    const d = await r.json().catch(() => ({}));
    return { ok: r.ok && d.success !== false, status: r.status, d };
  };
  try {
    const v = await get("/user/tokens/verify");
    if (!v.ok) {
      const msg = (v.d.errors && v.d.errors[0] && v.d.errors[0].message) || ("HTTP " + v.status);
      return { ok: false, error: msg };
    }
    const id = v.d.result && v.d.result.id ? v.d.result.id.slice(0, 8) + "…" : "token";
    const status = (v.d.result && v.d.result.status) || "unknown";

    // Permission groups — only readable if the token has "API Tokens Read"; best effort.
    const permissions = [];
    if (v.d.result && v.d.result.id) {
      const t = await get("/user/tokens/" + v.d.result.id);
      if (t.ok && t.d.result && Array.isArray(t.d.result.policies)) {
        const perms = new Set();
        for (const p of t.d.result.policies) for (const g of p.permission_groups || []) if (g.name) perms.add(g.name);
        for (const name of perms) permissions.push(name);
      }
    }

    // What it can actually reach: accounts + zones (domains).
    const accounts = [];
    const a = await get("/accounts?per_page=50");
    if (a.ok && Array.isArray(a.d.result)) {
      for (const x of a.d.result) accounts.push({ name: x.name, id: x.id });
    }
    const zones = [];
    let zonesTotal = 0;
    const z = await get("/zones?per_page=50");
    if (z.ok && Array.isArray(z.d.result)) {
      for (const x of z.d.result) zones.push({ name: x.name, id: x.id });
      zonesTotal = (z.d.result_info && z.d.result_info.total_count) || zones.length;
    }

    const out = { ok: true, identity: id, status, permissions, accounts, zones, zonesTotal, scopes: [] };
    if (!permissions.length) {
      out.permissionsNote = "Token can't read its own permissions (needs the 'API Tokens Read' permission).";
    }
    return out;
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
