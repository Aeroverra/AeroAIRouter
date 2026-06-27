// GitHub plugin. A thin descriptor: it owns the host-side config (UI fields,
// secret wiring) and launches the bundled, standalone MCP server in ./mcp.
// All GitHub logic lives in the MCP server, which is env-driven and works in any
// MCP client (Claude Desktop, Cursor, ...) without this plugin — see mcp/README.md.
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dir = dirname(fileURLToPath(import.meta.url));

export const meta = {
  name: "github",
  label: "GitHub",
  description: "Create and manage GitHub repositories and issues via the GitHub API.",
};

export const enabledByDefault = true;
export const secrets = ["GITHUB_TOKEN"];
export const defaults = { defaultVisibility: "private" };

export const configSchema = [
  { secret: "GITHUB_TOKEN", label: "GitHub token", type: "secret", help: "A personal access token with 'repo' scope. Create at github.com/settings/tokens." },
  { path: "defaultVisibility", label: "New repos default to", type: "select", options: ["private", "public"], help: "Visibility used when create_repo doesn't specify one." },
];

// Returns the launch spec for the bundled MCP server. Secrets are projected into
// the child's env here; the server only ever reads env vars.
export function mcp(ctx) {
  const vis =
    (ctx.pluginConfig && ctx.pluginConfig.defaultVisibility) ||
    (ctx.config && ctx.config.integrations && ctx.config.integrations.github && ctx.config.integrations.github.defaultVisibility) ||
    "private";
  return {
    transport: "stdio",
    command: process.execPath, // the same node that runs the bot
    args: [join(__dir, "mcp", "index.js")],
    trust: "owner",
    env: {
      GITHUB_TOKEN: ctx.secret("GITHUB_TOKEN") || "",
      GITHUB_DEFAULT_VISIBILITY: vis,
    },
  };
}
