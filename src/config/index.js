import { readFileSync, existsSync } from "fs";
import { loadSecrets } from "./secrets.js";
import {
  INSTALL_DIR,
  AIROUTER_HOME,
  CONFIG_FILE,
  SECRETS_FILE,
  DATA_DIR,
  PERSONA_DIR,
  CREDENTIALS_DIR,
  PLUGINS_DIR,
} from "./paths.js";

// 1) Pull secrets.env into process.env (a real process env var always wins).
loadSecrets();

function fail(msg) {
  console.error("[config] " + msg);
  process.exit(1);
}

// 2) Load the non-secret config.json from AIROUTER_HOME.
if (!existsSync(CONFIG_FILE)) {
  fail(
    "No config found at " + CONFIG_FILE + "\n" +
      "  Set AIROUTER_HOME, or copy examples/config.example.json there and fill it in.\n" +
      "  (Run scripts/install.sh for guided setup.)"
  );
}

let fileConfig;
try {
  fileConfig = JSON.parse(readFileSync(CONFIG_FILE, "utf8"));
} catch (err) {
  fail("config.json is not valid JSON (" + CONFIG_FILE + "): " + err.message);
}

// 3) Defaults for everything non-secret. config.json overrides these; secrets
//    come only from the environment / secrets.env, never from config.json.
const defaults = {
  discord: {
    ownerId: "",
    elevatedUsers: [],
    allowedBots: [],
    wakeWord: "",
    presenceGreetings: [],
    channels: [],
    guilds: {},
    people: {},
    activity: { text: "", url: "" },
  },
  ai: {
    auth: { mode: "auto" }, // auto | apikey | oauth
    accountUuid: "", // optional; only used by the OAuth provider's metadata
    models: { casual: "claude-opus-4-8", complex: "claude-opus-4-8" },
    maxTokens: 128000,
    maxHistoryPerChannel: 100,
  },
  persona: { emoji: "" },
  plugins: { enabled: [], disabled: [], uninstalled: [], config: {} },
  mcp: { servers: [] }, // direct MCP servers: [{ name, transport, command, args, env, enabled, trust }]
  review: { policy: "allow", dangerPatterns: [], allowReviewerOverride: false },
  features: { voice: false },
  voice: { channelId: "", whisperPath: "", edgeTtsPath: "", ttsCacheDir: "/tmp/aeroairouter-tts" },
  update: { enabled: false, branch: "main", intervalHours: 24, channelId: "" },
  integrations: {
    github: { defaultVisibility: "private" },
    cloudflare: { enabled: false, accountId: "" },
  },
};

function mergeDeep(base, override) {
  if (Array.isArray(override)) return override.slice();
  if (override && typeof override === "object") {
    const out = { ...base };
    for (const key of Object.keys(override)) {
      out[key] = mergeDeep(base ? base[key] : undefined, override[key]);
    }
    return out;
  }
  return override === undefined ? base : override;
}

const merged = mergeDeep(defaults, fileConfig);

// 4) Secrets come from the environment only.
const secrets = {
  discordToken: process.env.DISCORD_TOKEN || "",
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || "",
  oauthToken: process.env.CLAUDE_CODE_OAUTH_TOKEN || "",
  braveApiKey: process.env.BRAVE_API_KEY || "",
};

// 5) Validate required configuration with actionable messages.
const problems = [];
if (!secrets.discordToken) problems.push("DISCORD_TOKEN is not set (put it in " + SECRETS_FILE + ")");
if (!merged.discord.ownerId) problems.push("discord.ownerId is empty in config.json");
if (!secrets.anthropicApiKey && !secrets.oauthToken) {
  problems.push(
    "No Claude credential found — set ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN in " + SECRETS_FILE
  );
}
const wantMode = (merged.ai.auth && merged.ai.auth.mode) || "auto";
if (wantMode === "oauth" && !secrets.oauthToken) {
  problems.push("ai.auth.mode is 'oauth' but CLAUDE_CODE_OAUTH_TOKEN is not set in " + SECRETS_FILE);
}
if (wantMode === "apikey" && !secrets.anthropicApiKey) {
  problems.push("ai.auth.mode is 'apikey' but ANTHROPIC_API_KEY is not set in " + SECRETS_FILE);
}
if (problems.length) {
  fail("Configuration problems:\n  - " + problems.join("\n  - "));
}

// Soft warnings: the routing logic expects "home" and "public" guild roles.
// A single-guild setup can point both at the same guild id.
for (const role of ["home", "public"]) {
  if (!merged.discord.guilds[role] || !merged.discord.guilds[role].channels) {
    console.warn("[config] discord.guilds." + role + " is not fully configured — some routing may be limited");
  }
}

const config = {
  // paths
  projectRoot: INSTALL_DIR,
  installDir: INSTALL_DIR,
  airouterHome: AIROUTER_HOME,
  dataDir: DATA_DIR,
  personaDir: PERSONA_DIR,
  credentialsDir: CREDENTIALS_DIR,
  pluginsDir: PLUGINS_DIR,

  // discord (shape preserved for backward compatibility)
  discord: {
    token: secrets.discordToken,
    ownerId: merged.discord.ownerId,
    elevatedUsers: merged.discord.elevatedUsers,
    allowedBots: merged.discord.allowedBots,
    wakeWord: merged.discord.wakeWord,
    presenceGreetings: merged.discord.presenceGreetings,
    channels: merged.discord.channels,
    guilds: merged.discord.guilds,
    people: merged.discord.people,
    activity: merged.discord.activity,
  },

  // ai
  ai: {
    auth: merged.ai.auth,
    accountUuid: merged.ai.accountUuid,
    anthropicApiKey: secrets.anthropicApiKey,
    oauthToken: secrets.oauthToken,
    models: merged.ai.models,
    maxTokens: merged.ai.maxTokens,
    maxHistoryPerChannel: merged.ai.maxHistoryPerChannel,
  },

  // misc secrets / feature config
  braveApiKey: secrets.braveApiKey,
  persona: merged.persona,
  plugins: merged.plugins,
  mcp: merged.mcp,
  review: merged.review,
  features: merged.features,
  voice: merged.voice,
  update: merged.update,
  integrations: merged.integrations,
};

export default config;
