import config from "../config/index.js";
import { registerTool } from "../tools/definitions.js";
import { registerCommandReviewer, isDangerousCommand } from "../tools/command-review.js";
import { discoverPlugins, isPluginEnabled } from "./registry.js";
import { addPluginServer } from "../mcp/client.js";

// The surface a plugin's register(api) gets. Kept small and stable.
function buildPluginApi(name) {
  return {
    config,
    log: (msg) => console.log("[plugin:" + name + "] " + msg),
    registerTool, // (schema, handler, opts?) -> adds a tool the model can call
    registerCommandReviewer, // (fn) -> adds a bash-command safety reviewer
    isDangerousCommand, // reuse the core danger-pattern check
    // (name?) -> raw plugins.config[name]; defaults to this plugin's config.
    pluginConfig: (n) => (config.plugins && config.plugins.config && config.plugins.config[n || name]) || {},
  };
}

export async function loadPlugins() {
  const all = await discoverPlugins();
  if (!all.length) {
    console.log("[plugins] none found");
    return;
  }
  for (const p of all) {
    if (p.broken) {
      console.error("[plugins] " + p.name + " failed to load: " + p.error);
      continue;
    }
    if (!isPluginEnabled(p.name, p, config)) {
      console.log("[plugins] " + p.name + " disabled");
      continue;
    }
    const userConf = (config.plugins && config.plugins.config && config.plugins.config[p.name]) || {};
    const pluginConfig = { ...p.defaults, ...userConf };
    const mod = p._mod;
    try {
      if (typeof mod.register === "function") {
        await mod.register(buildPluginApi(p.name));
      }
      let mcpAdded = false;
      if (typeof mod.mcp === "function") {
        const ctx = {
          dir: p.dir,
          pluginConfig,
          config,
          secret: (k) => process.env[k] || "",
        };
        const spec = mod.mcp(ctx);
        if (spec) { addPluginServer(p.name, spec, { label: p.label }); mcpAdded = true; }
      }
      console.log("[plugins] loaded " + p.name + (mcpAdded ? " (+mcp)" : (typeof mod.mcp === "function" ? " (mcp idle — not configured)" : "")));
    } catch (err) {
      console.error("[plugins] failed to init " + p.name + ": " + err.message);
    }
  }
}
