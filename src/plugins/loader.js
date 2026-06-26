import { existsSync } from "fs";
import { join } from "path";
import { pathToFileURL } from "url";
import config from "../config/index.js";
import { INSTALL_DIR, PLUGINS_DIR } from "../config/paths.js";
import { registerTool } from "../tools/definitions.js";
import { registerCommandReviewer, isDangerousCommand } from "../tools/command-review.js";

// Resolve a plugin entry. User plugins (AIROUTER_HOME/plugins) take precedence
// over the built-in/example plugins shipped in the repo (INSTALL_DIR/plugins).
function resolvePluginEntry(name) {
  // Guard against path traversal / absolute paths in plugin names.
  if (!/^[A-Za-z0-9_-]+$/.test(name)) {
    console.error("[plugins] invalid plugin name (allowed: letters, digits, - _): " + name);
    return null;
  }
  const candidates = [
    join(PLUGINS_DIR, name, "index.js"),
    join(INSTALL_DIR, "plugins", name, "index.js"),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

// The surface a plugin's register(api) gets. Kept small and stable.
function buildPluginApi() {
  return {
    config,
    log: (msg) => console.log("[plugin] " + msg),
    registerTool, // (schema, handler) -> adds a tool the model can call
    registerCommandReviewer, // (fn) -> adds a bash-command safety reviewer
    isDangerousCommand, // reuse the core danger-pattern check
    pluginConfig: (name) =>
      (config.plugins && config.plugins.config && config.plugins.config[name]) || {},
  };
}

export async function loadPlugins() {
  const enabled = (config.plugins && config.plugins.enabled) || [];
  if (!enabled.length) {
    console.log("[plugins] none enabled");
    return;
  }
  const api = buildPluginApi();
  for (const name of enabled) {
    const entry = resolvePluginEntry(name);
    if (!entry) {
      console.error("[plugins] not found (looked in AIROUTER_HOME/plugins and ./plugins): " + name);
      continue;
    }
    try {
      const mod = await import(pathToFileURL(entry).href);
      if (typeof mod.register !== "function") {
        console.error("[plugins] " + name + " has no register() export — skipping");
        continue;
      }
      await mod.register(api);
      console.log("[plugins] loaded " + name);
    } catch (err) {
      console.error("[plugins] failed to load " + name + ": " + err.message);
    }
  }
}
