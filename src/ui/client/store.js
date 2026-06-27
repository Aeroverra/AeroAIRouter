// Global reactive state (signals) + small helpers. Non-reactive edit buffers
// (config/secret/persona working copies) live as plain objects.
import { signal } from "@preact/signals";

export const S = {
  booting: signal(true),
  authed: signal(false),
  needsSetup: signal(false),
  setupStatus: signal(null),

  route: signal("__dash"),
  config: signal({}),
  secrets: signal({}),       // presence booleans
  schema: signal([]),
  plugins: signal([]),
  pluginSecrets: signal({}),

  advanced: signal(false),
  theme: signal("dark"),
  botStatus: signal("…"),
  sidebarOpen: signal(false),

  toasts: signal([]),
  dialog: signal(null),
  savers: signal({}),         // scope -> { label, save:async()=>{}, count?:n }

  discordChannels: signal(null),
  netinfo: signal(null),
};

// non-reactive working buffers (edited in place, flushed on save)
export const buffers = { secretEdits: {}, personaEdits: {}, personaCache: {} };

export function getPath(o, p) { return p.split(".").reduce((a, k) => (a == null ? undefined : a[k]), o); }
export function setPath(o, p, v) {
  const ks = p.split(".");
  let c = o;
  for (let i = 0; i < ks.length - 1; i++) { if (typeof c[ks[i]] !== "object" || c[ks[i]] === null) c[ks[i]] = {}; c = c[ks[i]]; }
  c[ks[ks.length - 1]] = v;
}
export function deepMerge(base, over) {
  if (Array.isArray(over)) return over.slice();
  if (over && typeof over === "object") {
    const out = Object.assign({}, base);
    for (const k of Object.keys(over)) out[k] = deepMerge(base ? base[k] : undefined, over[k]);
    return out;
  }
  return over === undefined ? base : over;
}

// ---- toasts ----
let toastId = 0;
export function toast(msg, kind) {
  const id = ++toastId;
  S.toasts.value = [...S.toasts.value, { id, msg, kind }];
  setTimeout(() => dismissToast(id), kind === "bad" ? 6000 : 3000);
}
export function dismissToast(id) { S.toasts.value = S.toasts.value.filter((t) => t.id !== id); }

// ---- promise-based dialogs (replace window.confirm / prompt) ----
export function showDialog(spec) {
  return new Promise((resolve) => {
    S.dialog.value = { ...spec, _resolve: (v) => { S.dialog.value = null; resolve(v); } };
  });
}
export function confirmDialog(opts) { return showDialog({ type: "confirm", ...opts }); }
export function promptDialog(opts) { return showDialog({ type: "prompt", ...opts }); }

// ---- unified dirty / save registry ----
export function registerDirty(scope, entry) { S.savers.value = { ...S.savers.value, [scope]: entry }; }
export function clearDirty(scope) { const n = { ...S.savers.value }; delete n[scope]; S.savers.value = n; }
export function dirtyScopes() { return Object.keys(S.savers.value); }

// theme
export function applyTheme(t) {
  S.theme.value = t;
  document.documentElement.setAttribute("data-theme", t);
  try { localStorage.setItem("airouter-theme", t); } catch {}
}
