// Side-effectful actions: boot, the unified save model, and data refreshers.
import { api, setCsrf } from "./api.js";
import { S, buffers, registerDirty, clearDirty, dirtyScopes, toast, applyTheme } from "./store.js";

export async function reloadConfig() {
  const d = await api("GET", "/api/config");
  S.config.value = d.config || {};
  S.secrets.value = d.secrets || {};
  S.schema.value = d.schema || [];
  buffers.secretEdits = {};
  buffers.personaEdits = {};
}
export async function reloadPlugins() {
  try { const pd = await api("GET", "/api/plugins"); S.plugins.value = pd.plugins || []; S.pluginSecrets.value = pd.secrets || {}; }
  catch { S.plugins.value = []; S.pluginSecrets.value = {}; }
}
export async function refreshBotStatus() {
  try { const r = await api("GET", "/api/bot/status"); S.botStatus.value = r.status; }
  catch { S.botStatus.value = "?"; }
}

// The "settings" scope flushes config + secret + persona edits together.
export async function saveSettings() {
  await api("PUT", "/api/config", { config: S.config.value });
  const su = {};
  for (const [k, v] of Object.entries(buffers.secretEdits)) {
    if (v === null) su[k] = null; else if (v && v.trim()) su[k] = v.trim();
  }
  if (Object.keys(su).length) { const r = await api("PUT", "/api/secrets", { secrets: su }); S.secrets.value = r.secrets; }
  for (const [n, c] of Object.entries(buffers.personaEdits)) await api("PUT", "/api/persona/" + n, { content: c });
  buffers.secretEdits = {}; buffers.personaEdits = {};
}
export function markSettingsDirty(count) {
  registerDirty("settings", { label: "settings", save: saveSettings });
}

// Save every dirty scope through its registered saver.
export async function saveAll() {
  const entries = Object.entries(S.savers.value);
  if (!entries.length) return;
  try {
    for (const [scope, e] of entries) { await e.save(); clearDirty(scope); }
    toast("Saved. Restart the bot to apply.");
    await reloadConfig();
  } catch (ex) { toast(ex.message, "bad"); }
}
export async function discardAll() {
  S.savers.value = {};
  await reloadConfig();
  await reloadPlugins();
  toast("Changes discarded", "info");
}

export async function boot() {
  try { const t = localStorage.getItem("airouter-theme"); applyTheme(t === "light" ? "light" : "dark"); } catch { applyTheme("dark"); }
  const status = await api("GET", "/api/status").catch(() => ({}));
  if (status.needsPassword || status.needsConfig) { S.needsSetup.value = true; S.setupStatus.value = status; S.booting.value = false; return; }
  if (!status.authed) { S.authed.value = false; S.booting.value = false; return; }
  await afterAuth();
}

export async function afterAuth() {
  S.authed.value = true;
  await reloadConfig();
  if (!S.savers.value || true) { /* fresh */ }
  try { const c = await api("GET", "/api/csrf"); setCsrf(c.csrf); } catch {}
  await reloadPlugins();
  S.booting.value = false;
  refreshBotStatus();
}
