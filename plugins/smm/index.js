// SMM panels plugin. Wraps MoreThanPanel + JustAnotherPanel (both the standard SMM
// API v2) as an MCP server, so the bot places REAL orders through the API and reads
// REAL balance/status — instead of hand-rolling curl, which led to hallucinated
// orders. Owner-only. Keys live in secrets.env; the plugin stays idle until at
// least one is set.
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dir = dirname(fileURLToPath(import.meta.url));

export const meta = {
  name: "smm",
  label: "SMM Panels",
  description: "MoreThanPanel + JustAnotherPanel (SMM API v2): real balance / services / order / status tools so orders are placed for real, not hallucinated.",
};

export const enabledByDefault = true;
export const secrets = ["MORETHANPANEL_KEY", "JUSTANOTHERPANEL_KEY"];
export const defaults = {
  defaultPanel: "morethanpanel",
  morethanpanelUrl: "https://morethanpanel.com/api/v2",
  justanotherpanelUrl: "https://justanotherpanel.com/api/v2",
};
export const configSchema = [
  { path: "defaultPanel", label: "Default panel", type: "select", options: ["morethanpanel", "justanotherpanel"], help: "Used when a tool call doesn't name a panel. MoreThanPanel is preferred." },
  { path: "morethanpanelUrl", label: "MoreThanPanel API URL", type: "string", advanced: true },
  { path: "justanotherpanelUrl", label: "JustAnotherPanel API URL", type: "string", advanced: true },
];

export function mcp(ctx) {
  const mtpKey = ctx.secret("MORETHANPANEL_KEY");
  const japKey = ctx.secret("JUSTANOTHERPANEL_KEY");
  if (!mtpKey && !japKey) return null; // idle until at least one panel key is set
  const cfg = ctx.pluginConfig || {};
  return {
    transport: "stdio",
    command: process.execPath,
    args: [join(__dir, "mcp", "index.js")],
    trust: "owner",
    env: {
      MTP_URL: cfg.morethanpanelUrl || "https://morethanpanel.com/api/v2",
      MTP_KEY: mtpKey || "",
      JAP_URL: cfg.justanotherpanelUrl || "https://justanotherpanel.com/api/v2",
      JAP_KEY: japKey || "",
      SMM_DEFAULT: cfg.defaultPanel || "morethanpanel",
    },
  };
}
