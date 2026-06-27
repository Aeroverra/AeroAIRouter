import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, chmodSync } from "fs";
import { join } from "path";
import {
  AIROUTER_HOME,
  CONFIG_FILE,
  SECRETS_FILE,
  PERSONA_DIR,
  CREDENTIALS_DIR,
  PLUGINS_DIR,
  DATA_DIR,
} from "../config/paths.js";

// Fixed secret keys the UI always shows (values live only in secrets.env / env,
// never in config.json).
export const SECRET_KEYS = [
  "DISCORD_TOKEN",
  "ANTHROPIC_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "BRAVE_API_KEY",
  "CLOUDFLARE_TOKEN",
];

// GitHub tokens are dynamic: GITHUB_TOKEN or GITHUB_TOKEN_<SLUG> (multiple).
const GITHUB_KEY_RE = /^GITHUB_TOKEN(_[A-Z0-9_]+)?$/;

// Secret keys declared by plugins (registered at runtime by the UI server).
const extraSecretKeys = new Set();
export function allowSecretKeys(keys) {
  for (const k of keys || []) if (/^[A-Z][A-Z0-9_]*$/.test(k)) extraSecretKeys.add(k);
}

function isAllowedSecretKey(k) {
  return SECRET_KEYS.includes(k) || GITHUB_KEY_RE.test(k) || extraSecretKeys.has(k);
}

export const PERSONA_FILES = ["soul.md", "heartbeat.md", "memory.md"];

function ensureDirs() {
  for (const d of [AIROUTER_HOME, DATA_DIR, PERSONA_DIR, CREDENTIALS_DIR, PLUGINS_DIR]) {
    if (!existsSync(d)) mkdirSync(d, { recursive: true });
  }
}

// Atomic write: write to a temp file then rename over the target.
function atomicWrite(file, content, mode) {
  ensureDirs();
  const tmp = file + ".tmp-" + process.pid;
  writeFileSync(tmp, content, { encoding: "utf8", mode: mode || 0o644 });
  if (mode) {
    try { chmodSync(tmp, mode); } catch {}
  }
  renameSync(tmp, file);
}

export function configExists() {
  return existsSync(CONFIG_FILE);
}

export function readConfig() {
  if (!existsSync(CONFIG_FILE)) return {};
  return JSON.parse(readFileSync(CONFIG_FILE, "utf8"));
}

export function writeConfig(obj) {
  atomicWrite(CONFIG_FILE, JSON.stringify(obj, null, 2) + "\n", 0o600);
}

// Parse secrets.env into a key->value map.
export function readSecretsMap() {
  const map = {};
  if (!existsSync(SECRETS_FILE)) return map;
  const raw = readFileSync(SECRETS_FILE, "utf8");
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const body = t.startsWith("export ") ? t.slice(7).trim() : t;
    const eq = body.indexOf("=");
    if (eq === -1) continue;
    const k = body.slice(0, eq).trim();
    let v = body.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (k) map[k] = v;
  }
  return map;
}

// Which secrets are set (booleans only — values are never sent to the client).
export function secretPresence() {
  const map = readSecretsMap();
  const out = {};
  for (const k of SECRET_KEYS) out[k] = !!(process.env[k] || map[k]);
  for (const k of extraSecretKeys) out[k] = !!(process.env[k] || map[k]);
  for (const k of Object.keys(map)) if (GITHUB_KEY_RE.test(k)) out[k] = !!map[k];
  for (const k of Object.keys(process.env)) if (GITHUB_KEY_RE.test(k)) out[k] = true;
  return out;
}

// Update secrets.env. `updates` is a partial map; only provided keys are changed.
// A null value DELETES the key; an empty string clears it. Others are preserved.
export function updateSecrets(updates) {
  const map = readSecretsMap();
  for (const [k, v] of Object.entries(updates || {})) {
    if (!isAllowedSecretKey(k)) continue;
    if (v === null) { delete map[k]; continue; }
    if (typeof v !== "string") continue;
    map[k] = v;
  }
  const order = [...SECRET_KEYS, ...Object.keys(map).filter((k) => !SECRET_KEYS.includes(k))];
  const lines = [
    "# AeroAIRouter secrets — managed by the config UI. chmod 600.",
  ];
  for (const k of order) {
    if (map[k] === undefined) continue;
    lines.push(k + "=" + map[k]);
  }
  atomicWrite(SECRETS_FILE, lines.join("\n") + "\n", 0o600);
}

export function readPersona(name) {
  if (!PERSONA_FILES.includes(name)) throw new Error("invalid persona file");
  const p = join(PERSONA_DIR, name);
  return existsSync(p) ? readFileSync(p, "utf8") : "";
}

export function writePersona(name, content) {
  if (!PERSONA_FILES.includes(name)) throw new Error("invalid persona file");
  atomicWrite(join(PERSONA_DIR, name), String(content == null ? "" : content), 0o644);
}

export { AIROUTER_HOME };
