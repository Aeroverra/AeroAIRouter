// Plugin discovery, shared by the bot's plugin loader and the config UI.
// A plugin is a folder with an index.js that exports a descriptor:
//
//   meta            { name, label, description }
//   enabledByDefault boolean   — on unless the user disables it
//   secrets         string[]   — secret env-var keys it uses (shown in the UI)
//   defaults        object     — default plugin config values
//   configSchema    field[]    — UI fields (path = key in plugins.config[name],
//                                 or secret = a secrets.env key)
//   register(api)   function?  — optional in-process hook (tools/command-review)
//   mcp(ctx)        function?  — optional; returns a launch spec for a bundled or
//                                 external MCP server. ctx = { dir, pluginConfig,
//                                 secret(name), config }.
//
// Discovery only imports the module to read its exports; it never calls
// register()/mcp(). User plugins (AIROUTER_HOME/plugins) override built-in ones
// (INSTALL_DIR/plugins) with the same name.
import { existsSync, readdirSync } from "fs";
import { join, dirname } from "path";
import { pathToFileURL } from "url";
import { INSTALL_DIR, PLUGINS_DIR } from "../config/paths.js";

const NAME_RE = /^[A-Za-z0-9_-]+$/;

function pluginBases() {
  // INSTALL_DIR first, PLUGINS_DIR (user) last so it wins in the name map.
  return [join(INSTALL_DIR, "plugins"), PLUGINS_DIR];
}

export function listPluginEntries() {
  const map = new Map(); // name -> index.js path
  for (const base of pluginBases()) {
    if (!existsSync(base)) continue;
    for (const name of readdirSync(base)) {
      if (!NAME_RE.test(name)) continue;
      const entry = join(base, name, "index.js");
      if (existsSync(entry)) map.set(name, entry);
    }
  }
  return map;
}

function describe(name, entry, mod) {
  const meta = mod.meta || {};
  return {
    name,
    dir: dirname(entry),
    label: meta.label || name,
    description: meta.description || "",
    hasMcp: typeof mod.mcp === "function",
    hasRegister: typeof mod.register === "function",
    hasCheckToken: typeof mod.checkToken === "function",
    hasActions: !!(mod.actions && typeof mod.actions === "object"),
    ui: typeof mod.ui === "string" ? mod.ui : null,
    enabledByDefault: mod.enabledByDefault === true,
    secrets: Array.isArray(mod.secrets) ? mod.secrets : [],
    configSchema: Array.isArray(mod.configSchema) ? mod.configSchema : [],
    defaults: mod.defaults && typeof mod.defaults === "object" ? mod.defaults : {},
    _mod: mod, // used in-process by the loader; the UI must not serialize this
  };
}

export async function discoverPlugins() {
  const out = [];
  for (const [name, entry] of listPluginEntries()) {
    try {
      const mod = await import(pathToFileURL(entry).href);
      out.push(describe(name, entry, mod));
    } catch (err) {
      out.push({ name, error: err.message, broken: true, secrets: [], configSchema: [] });
    }
  }
  return out;
}

// "Uninstalled" plugins are hidden from active use and from the installed list in
// the UI; their folder stays on disk (bundled ones can be reinstalled). Tracked in
// config.plugins.uninstalled.
export function isPluginUninstalled(name, config) {
  const un = config && config.plugins && Array.isArray(config.plugins.uninstalled) ? config.plugins.uninstalled : [];
  return un.includes(name);
}

// enabled if: not uninstalled, not explicitly disabled, AND (explicitly enabled OR
// on by default).
export function isPluginEnabled(name, descriptor, config) {
  const plugins = (config && config.plugins) || {};
  const enabled = Array.isArray(plugins.enabled) ? plugins.enabled : [];
  const disabled = Array.isArray(plugins.disabled) ? plugins.disabled : [];
  if (isPluginUninstalled(name, config)) return false;
  if (disabled.includes(name)) return false;
  if (enabled.includes(name)) return true;
  return !!(descriptor && descriptor.enabledByDefault);
}
