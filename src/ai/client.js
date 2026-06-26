import Anthropic from "@anthropic-ai/sdk";
import { readFileSync, existsSync, writeFileSync } from "fs";
import { execSync } from "child_process";
import { join } from "path";
import { randomUUID } from "crypto";
import config from "../config/index.js";
import { DATA_DIR } from "../config/paths.js";
import { sleepSync } from "../util/sleep.js";

const SESSION_ID = randomUUID();

// ---------------------------------------------------------------------------
// Auth modes (both first-class, chosen during setup):
//   apikey  — standard ANTHROPIC_API_KEY via the SDK. The default.
//   oauth   — Claude subscription via a long-lived OAuth "setup-token", sent as
//             a bearer credential while replaying the Claude Code CLI headers.
//             A setup-token is a standalone credential (immune to refresh-token
//             rotation). If no static token is present, fall back to the legacy
//             flow: read the CLI's credentials file and refresh it via the CLI.
// mode = config.ai.auth.mode ("auto" picks apikey when an API key is present,
// otherwise oauth). config validation guarantees at least one credential exists.
// ---------------------------------------------------------------------------
function resolveMode() {
  const want = (config.ai.auth && config.ai.auth.mode) || "auto";
  if (want === "apikey" || want === "oauth") return want;
  return config.ai.anthropicApiKey ? "apikey" : "oauth";
}
const MODE = resolveMode();
console.log("[ai] Auth mode: " + MODE);

// ---- OAuth-mode state ----
const CLAUDE_CLI =
  process.env.CLAUDE_CLI || join(process.env.HOME || "", ".npm-global/bin/claude");
const LEGACY_CREDS_PATH = join(process.env.HOME || "", ".claude", ".credentials.json");
const ENV_TOKEN = config.ai.oauthToken || "";

let client = null;
let tokenExpiresAt = 0;
let currentAccessToken = "";
let deviceId = "";
let accountUuid = "";
let refreshInProgress = null;
let initialized = false;

// A stable per-install device id, persisted under AIROUTER_HOME/data, used only
// when no account UUID is configured/derivable. No identity is hardcoded.
function persistentDeviceId() {
  const idFile = join(DATA_DIR, "device-id");
  try {
    if (existsSync(idFile)) {
      const v = readFileSync(idFile, "utf8").trim();
      if (v) return v;
    }
  } catch {}
  const id = randomUUID();
  try { writeFileSync(idFile, id, "utf8"); } catch {}
  return id;
}

function loadDeviceInfo() {
  // account_uuid (for OAuth metadata): config, else the local Claude CLI account,
  // else empty. device_id: a stable, persisted per-install id — never hardcoded.
  accountUuid = config.ai.accountUuid || "";
  if (!accountUuid) {
    try {
      const claudeJson = JSON.parse(
        readFileSync(join(process.env.HOME || "", ".claude.json"), "utf8")
      );
      accountUuid = (claudeJson.oauthAccount || {}).accountUuid || "";
    } catch {}
  }
  deviceId = persistentDeviceId();
}

function loadTokenFromDisk() {
  const raw = JSON.parse(readFileSync(LEGACY_CREDS_PATH, "utf8"));
  const oauth = raw.claudeAiOauth;
  tokenExpiresAt = oauth.expiresAt;
  currentAccessToken = oauth.accessToken;
  console.log("[ai] Loaded token from disk, expires at " + new Date(tokenExpiresAt).toISOString());
  return oauth.accessToken;
}

function refreshViaCli() {
  console.log("[ai] Refreshing token via Claude CLI...");
  try {
    execSync(CLAUDE_CLI + ' --print -p "ok"', { timeout: 60000, encoding: "utf8", stdio: "pipe" });
    loadTokenFromDisk();
    var timeLeft = tokenExpiresAt - Date.now();
    if (timeLeft <= 0) {
      console.error("[ai] CLI refresh ran but token is still expired (expiry=" + new Date(tokenExpiresAt).toISOString() + ")");
      return false;
    }
    console.log("[ai] CLI refresh succeeded, new token expires at " + new Date(tokenExpiresAt).toISOString() + " (" + Math.round(timeLeft / 60000) + "min)");
    return true;
  } catch (err) {
    console.error("[ai] CLI refresh failed:", (err.stderr || err.message || "").substring(0, 300));
    return false;
  }
}

function doRefresh() {
  for (var attempt = 1; attempt <= 3; attempt++) {
    console.log("[ai] Refresh attempt " + attempt + "/3");
    if (refreshViaCli()) {
      client = null;
      return true;
    }
    if (attempt < 3) {
      sleepSync(2000);
    }
  }
  console.error("[ai] All 3 refresh attempts failed");
  return false;
}

async function refreshToken() {
  if (refreshInProgress) return refreshInProgress;
  refreshInProgress = (async () => {
    try {
      // Yield a microtask so refreshInProgress is set BEFORE the finally clears
      // it. doRefresh() is synchronous (execSync); without the yield the finally
      // runs first, leaving a stale resolved promise that makes every later
      // refresh a silent no-op. (Auth-wedge fix, 2026-06-04.)
      await null;
      return doRefresh();
    } finally {
      refreshInProgress = null;
    }
  })();
  return refreshInProgress;
}

async function ensureFreshToken() {
  if (MODE !== "oauth") return;
  if (!initialized) {
    initialized = true;
    loadDeviceInfo();
    if (ENV_TOKEN) {
      currentAccessToken = ENV_TOKEN;
      console.log("[ai] Using long-lived OAuth setup-token; CLI refresh disabled");
      return;
    }
    loadTokenFromDisk();
  }
  if (ENV_TOKEN) return; // static token never expires within the process lifetime

  var timeLeft = tokenExpiresAt - Date.now();
  if (timeLeft > 300000) return;
  console.log("[ai] Token " + (timeLeft <= 0 ? "expired" : "expires in " + Math.round(timeLeft / 60000) + "min") + ", refreshing...");
  await refreshToken();
}

export function forceRefresh() {
  client = null;
  if (MODE !== "oauth") return Promise.resolve(false);
  if (ENV_TOKEN) {
    console.warn("[ai] 401 with long-lived OAuth token — cannot auto-refresh; token may be revoked/expired (re-run `claude setup-token`)");
    return Promise.resolve(false);
  }
  console.log("[ai] Forced token refresh triggered (401 recovery)");
  return refreshToken();
}

export async function getClient() {
  if (MODE === "apikey") {
    if (client) return client;
    client = new Anthropic({ apiKey: config.ai.anthropicApiKey });
    return client;
  }

  await ensureFreshToken();
  if (client) return client;
  client = new Anthropic({
    authToken: currentAccessToken,
    defaultHeaders: {
      "anthropic-dangerous-direct-browser-access": "true",
      "anthropic-beta":
        "claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,web-search-2025-03-05",
      "x-app": "cli",
      "user-agent": "claude-cli/2.1.159 (external, sdk-cli)",
      "x-claude-code-session-id": SESSION_ID,
    },
    defaultQuery: { beta: "true" },
  });
  return client;
}

export function getMetadata() {
  if (MODE !== "oauth") return {};
  return {
    user_id: JSON.stringify({
      device_id: deviceId,
      account_uuid: accountUuid,
      session_id: SESSION_ID,
    }),
  };
}

// Only the OAuth/CLI path needs the billing header block. In API-key mode this is
// null and callers filter it out of the system array.
export const BILLING_SYSTEM_BLOCK =
  MODE === "oauth"
    ? {
        type: "text",
        text: "x-anthropic-billing-header: cc_version=2.1.159.286; cc_entrypoint=sdk-cli; cch=e2159;",
      }
    : null;

export function getAuthMode() {
  return MODE;
}
