// Example plugin — a template for writing your own.
//
// A plugin is a folder with an index.js. It can do two independent things:
//   1) register(api)  — add in-process tools / bash-command reviewers
//   2) mcp(ctx)       — launch a bundled or external MCP server (its tools are
//                       merged into the bot and shown under the MCP tab)
// You can use either, both, or neither.
//
// Place it at AIROUTER_HOME/plugins/<name>/ (user) or ./plugins/<name>/ (bundled).
// Enable/disable and configure it from the UI's Plugins tab, or via
// config.plugins.{enabled,disabled,config}.

// ---- descriptor (read by the UI + loader; no side effects) ----
export const meta = {
  name: "example-plugin",
  label: "Example",
  description: "Template plugin. Disabled by default.",
};

// Off unless the user enables it. Set true for plugins that should be on by default.
export const enabledByDefault = false;

// Secret env-var keys this plugin uses (shown in the Plugins tab; stored in secrets.env).
export const secrets = [];

// Default values for this plugin's config (config.plugins.config["example-plugin"]).
export const defaults = { greeting: "pong" };

// UI fields. `path` is a key in this plugin's config; `secret` is a secrets.env key.
export const configSchema = [
  { path: "greeting", label: "Reply text", type: "string", help: "What ping_example returns." },
];

// ---- in-process hooks ----
export function register(api) {
  // api.pluginConfig() returns this plugin's saved config (without `defaults`
  // merged — read defaults yourself if a key may be unset).
  const conf = api.pluginConfig();

  api.registerTool(
    {
      name: "ping_example",
      description: "Example plugin tool — returns the configured reply.",
      input_schema: { type: "object", properties: {} },
    },
    async () => ({ success: true, message: conf.greeting || "pong" }),
    { trust: "owner" } // who may call it: owner (default) | elevated | light
  );

  // Bash-command reviewer. null = no opinion (fall through to core policy);
  // { approved:false, reason } = block; { approved:true } = allow.
  api.registerCommandReviewer((command) => {
    if (/example-forbidden-token/i.test(command)) {
      return { approved: false, reason: "blocked by example-plugin", reviewer: "example-plugin" };
    }
    return null;
  });

  api.log("example-plugin loaded");
}

// ---- bundled/external MCP server (optional) ----
// Uncomment to launch an MCP server. ctx = { dir, pluginConfig, config, secret(name) }.
// Secrets are projected into the child's env here; the server reads only env.
// See plugins/github for a complete example.
//
// import { dirname, join } from "path";
// import { fileURLToPath } from "url";
// const __dir = dirname(fileURLToPath(import.meta.url));
// export function mcp(ctx) {
//   return {
//     transport: "stdio",
//     command: process.execPath,
//     args: [join(__dir, "mcp", "index.js")],
//     trust: "owner",
//     env: { SOME_TOKEN: ctx.secret("SOME_TOKEN") || "" },
//   };
// }
