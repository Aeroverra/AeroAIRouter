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
export const defaults = { accountId: "" };

export const configSchema = [
  { secret: "CLOUDFLARE_TOKEN", label: "Cloudflare API token", type: "secret", help: "Create at dash.cloudflare.com → My Profile → API Tokens (Zone:DNS edit, Zone:Read)." },
  { path: "accountId", label: "Account ID", type: "string", help: "Optional. Found on any Cloudflare dashboard page sidebar." },
];

export function mcp(ctx) {
  const accountId =
    (ctx.pluginConfig && ctx.pluginConfig.accountId) ||
    (ctx.config && ctx.config.integrations && ctx.config.integrations.cloudflare && ctx.config.integrations.cloudflare.accountId) ||
    "";
  return {
    transport: "stdio",
    command: process.execPath,
    args: [join(__dir, "mcp", "index.js")],
    trust: "owner",
    env: {
      CLOUDFLARE_TOKEN: ctx.secret("CLOUDFLARE_TOKEN") || "",
      CLOUDFLARE_ACCOUNT_ID: accountId,
    },
  };
}
