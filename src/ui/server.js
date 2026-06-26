import express from "express";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import cookieSession from "cookie-session";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { randomBytes } from "crypto";
import { readFileSync, existsSync } from "fs";
import { execFile } from "child_process";

import { INSTALL_DIR } from "../config/paths.js";
import * as io from "./configio.js";
import * as auth from "./auth.js";
import { accessUrls, advertiseMdns } from "./netinfo.js";
import { SECTIONS } from "./schema.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, "public");

function uiSettings() {
  const cfg = io.configExists() ? io.readConfig() : {};
  const ui = cfg.ui || {};
  return {
    port: Number(process.env.AIROUTER_UI_PORT || ui.port || 8787),
    host: process.env.AIROUTER_UI_HOST || ui.host || "0.0.0.0",
    serviceName: ui.serviceName || "aeroairouter.service",
    selfService: ui.selfService || "aeroairouter-ui.service",
    mdns: ui.mdns !== false,
  };
}

function deepMerge(base, over) {
  if (Array.isArray(over)) return over.slice();
  if (over && typeof over === "object") {
    const out = Object.assign({}, base);
    for (const k of Object.keys(over)) out[k] = deepMerge(base ? base[k] : undefined, over[k]);
    return out;
  }
  return over === undefined ? base : over;
}

function exampleConfig() {
  try {
    return JSON.parse(readFileSync(join(INSTALL_DIR, "examples", "config.example.json"), "utf8"));
  } catch {
    return {};
  }
}

// Fetch the bot's guilds and their text channels (shared by the dashboard and
// the setup wizard). Throws on failure.
async function fetchGuildChannels(token) {
  const headers = { Authorization: "Bot " + token };
  const gr = await fetch("https://discord.com/api/v10/users/@me/guilds", { headers, signal: AbortSignal.timeout(10000) });
  if (!gr.ok) throw new Error("Discord guilds fetch failed (HTTP " + gr.status + ")");
  const guilds = await gr.json();
  const out = [];
  for (const g of guilds) {
    let channels = [];
    try {
      const cr = await fetch("https://discord.com/api/v10/guilds/" + g.id + "/channels", { headers, signal: AbortSignal.timeout(10000) });
      if (cr.ok) {
        const chans = await cr.json();
        channels = chans.filter((c) => c.type === 0 || c.type === 5).map((c) => ({ id: c.id, name: c.name }));
      }
    } catch {}
    out.push({ guildId: g.id, guildName: g.name, channels });
  }
  return out;
}

// One-time setup token (only relevant before the admin password is set).
let setupToken = null;
function ensureSetupToken() {
  if (!auth.passwordIsSet() && !setupToken) {
    setupToken = randomBytes(4).toString("hex");
  }
  return setupToken;
}

export function createApp() {
  const app = express();
  app.disable("x-powered-by");
  // Directly exposed (no reverse proxy), so DON'T trust X-Forwarded-* — otherwise
  // a client could spoof it to bypass the login rate-limiter.
  app.set("trust proxy", false);

  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: true,
        directives: {
          "default-src": ["'self'"],
          "script-src": ["'self'"],
          "style-src": ["'self'"],
          "img-src": ["'self'", "data:"],
          "connect-src": ["'self'"],
          "object-src": ["'none'"],
          "frame-ancestors": ["'none'"],
          // Served over plain HTTP on LAN/Tailscale — must NOT force https upgrades.
          "upgrade-insecure-requests": null,
        },
      },
    })
  );
  app.use(express.json({ limit: "1mb" }));
  app.use(
    cookieSession({
      name: "airouter.sid",
      keys: [auth.getSessionSecret()],
      httpOnly: true,
      sameSite: "strict",
      maxAge: 7 * 24 * 60 * 60 * 1000,
    })
  );

  // Same-origin guard for mutating requests (CSRF defence-in-depth on top of
  // sameSite=strict cookies).
  app.use((req, res, next) => {
    if (["POST", "PUT", "DELETE", "PATCH"].includes(req.method)) {
      const origin = req.get("origin");
      if (origin) {
        const host = req.get("host");
        try {
          if (new URL(origin).host !== host) return res.status(403).json({ error: "bad origin" });
        } catch {
          return res.status(403).json({ error: "bad origin" });
        }
      }
    }
    next();
  });

  const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 12, standardHeaders: true, legacyHeaders: false });

  function csrfToken(req) {
    if (!req.session.csrf) req.session.csrf = randomBytes(16).toString("hex");
    return req.session.csrf;
  }
  function requireAuth(req, res, next) {
    if (req.session && req.session.authed) return next();
    return res.status(401).json({ error: "unauthorized" });
  }
  function requireCsrf(req, res, next) {
    const t = req.get("x-csrf-token");
    if (!t || !req.session.csrf || t !== req.session.csrf) {
      return res.status(403).json({ error: "bad csrf token" });
    }
    next();
  }
  // systemd unit names passed to execFile come from (admin-only) config; even
  // though execFile uses no shell, constrain them to valid service-name chars.
  const validService = (n) => typeof n === "string" && /^[A-Za-z0-9@._-]+\.service$/.test(n);

  // ---- public status ----
  app.get("/api/status", (req, res) => {
    const needsPassword = !auth.passwordIsSet();
    res.json({
      needsPassword,
      needsConfig: !io.configExists(),
      authed: !!(req.session && req.session.authed),
      setupTokenHint: needsPassword ? "Check the server console for the setup code." : undefined,
    });
  });

  // ---- first-run setup (only before password is set) ----
  app.post("/api/setup", loginLimiter, (req, res) => {
    if (auth.passwordIsSet()) return res.status(403).json({ error: "already set up" });
    const token = ensureSetupToken();
    const { setupCode, password, config, secrets } = req.body || {};
    if (token && setupCode !== token) return res.status(403).json({ error: "invalid setup code" });
    try {
      auth.setPassword(password);
      const merged = deepMerge(exampleConfig(), config || {});
      io.writeConfig(merged);
      if (secrets) io.updateSecrets(secrets);
      setupToken = null;
      req.session.authed = true;
      req.session.csrf = randomBytes(16).toString("hex");
      res.json({ ok: true, csrf: req.session.csrf });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // ---- auth ----
  app.post("/api/login", loginLimiter, (req, res) => {
    const { password } = req.body || {};
    if (!auth.passwordIsSet()) return res.status(409).json({ error: "not set up" });
    if (!auth.verifyPassword(password)) return res.status(401).json({ error: "invalid password" });
    req.session.authed = true;
    req.session.csrf = randomBytes(16).toString("hex");
    res.json({ ok: true, csrf: req.session.csrf });
  });

  app.post("/api/logout", (req, res) => {
    req.session = null;
    res.json({ ok: true });
  });

  app.get("/api/csrf", requireAuth, (req, res) => res.json({ csrf: csrfToken(req) }));

  // ---- validate a Discord bot token against the Discord API ----
  // Open only during first-run setup; once set up it requires a valid session
  // (so a set-up instance can't be used as an unauthenticated Discord oracle).
  app.post("/api/check-discord", loginLimiter, async (req, res) => {
    if (auth.passwordIsSet() && !(req.session && req.session.authed)) {
      return res.status(401).json({ error: "unauthorized" });
    }
    const token = (req.body && req.body.token) || "";
    if (!token) return res.status(400).json({ ok: false, error: "no token" });
    try {
      const r = await fetch("https://discord.com/api/v10/users/@me", {
        headers: { Authorization: "Bot " + token },
        signal: AbortSignal.timeout(10000),
      });
      if (!r.ok) return res.json({ ok: false, error: "Discord rejected the token (HTTP " + r.status + ")" });
      const u = await r.json();
      res.json({ ok: true, username: u.username, id: u.id });
    } catch (err) {
      res.json({ ok: false, error: err.message });
    }
  });

  // ---- list the bot's guilds + text channels (dashboard: uses saved token) ----
  app.get("/api/discord/channels", requireAuth, async (req, res) => {
    const token = process.env.DISCORD_TOKEN || io.readSecretsMap().DISCORD_TOKEN;
    if (!token) return res.status(400).json({ error: "DISCORD_TOKEN not set" });
    try {
      res.json({ guilds: await fetchGuildChannels(token) });
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });

  // ---- list channels for a supplied token (setup wizard, before token is saved)
  // Gated like check-discord: open during first-run, auth required once set up.
  app.post("/api/discord/list-channels", loginLimiter, async (req, res) => {
    if (auth.passwordIsSet() && !(req.session && req.session.authed)) {
      return res.status(401).json({ error: "unauthorized" });
    }
    const token = (req.body && req.body.token) || "";
    if (!token) return res.status(400).json({ error: "no token" });
    try {
      res.json({ guilds: await fetchGuildChannels(token) });
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });

  // ---- config (secrets never sent to the client) ----
  app.get("/api/config", requireAuth, (req, res) => {
    res.json({
      config: io.readConfig(),
      secrets: io.secretPresence(),
      schema: SECTIONS,
    });
  });

  app.put("/api/config", requireAuth, requireCsrf, (req, res) => {
    const cfg = req.body && req.body.config;
    if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) {
      return res.status(400).json({ error: "config must be an object" });
    }
    // config.json must never hold secrets.
    for (const k of io.SECRET_KEYS) delete cfg[k];
    try {
      io.writeConfig(cfg);
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.put("/api/secrets", requireAuth, requireCsrf, (req, res) => {
    const updates = req.body && req.body.secrets;
    if (!updates || typeof updates !== "object") return res.status(400).json({ error: "secrets must be an object" });
    try {
      io.updateSecrets(updates);
      res.json({ ok: true, secrets: io.secretPresence() });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // ---- persona files ----
  app.get("/api/persona/:name", requireAuth, (req, res) => {
    try {
      res.json({ content: io.readPersona(req.params.name) });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });
  app.put("/api/persona/:name", requireAuth, requireCsrf, (req, res) => {
    try {
      io.writePersona(req.params.name, (req.body && req.body.content) || "");
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // ---- change admin password ----
  app.put("/api/password", requireAuth, requireCsrf, (req, res) => {
    const { current, next } = req.body || {};
    if (!auth.verifyPassword(current)) return res.status(401).json({ error: "current password incorrect" });
    try {
      auth.setPassword(next);
      auth.rotateSessionSecret(); // invalidate all existing sessions
      res.json({ ok: true, restarting: true });
      // Restart the UI so the rotated secret takes effect (forces re-login).
      const svc = uiSettings().selfService;
      if (validService(svc)) setTimeout(() => execFile("systemctl", ["--user", "restart", svc], { timeout: 20000 }, () => {}), 300);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // ---- network info ----
  app.get("/api/netinfo", requireAuth, (req, res) => {
    res.json({ urls: accessUrls(uiSettings().port) });
  });

  // ---- bot control ----
  app.get("/api/bot/status", requireAuth, (req, res) => {
    const svc = uiSettings().serviceName;
    if (!validService(svc)) return res.json({ status: "unknown" });
    execFile("systemctl", ["--user", "is-active", svc], { timeout: 8000 }, (err, stdout) => {
      res.json({ status: (stdout || (err && err.message) || "unknown").toString().trim() });
    });
  });
  app.post("/api/bot/restart", requireAuth, requireCsrf, (req, res) => {
    const svc = uiSettings().serviceName;
    if (!validService(svc)) return res.status(400).json({ error: "invalid serviceName in config" });
    execFile("systemctl", ["--user", "restart", svc], { timeout: 20000 }, (err, stdout, stderr) => {
      if (err) return res.status(500).json({ error: (stderr || err.message || "restart failed").toString().trim() });
      res.json({ ok: true });
    });
  });

  // Restart the UI service itself (to apply network/bind changes). The response
  // is sent first; the restart happens a moment later so the client gets it.
  app.post("/api/ui/restart", requireAuth, requireCsrf, (req, res) => {
    const svc = uiSettings().selfService;
    if (!validService(svc)) return res.status(400).json({ error: "invalid selfService in config" });
    res.json({ ok: true });
    setTimeout(() => execFile("systemctl", ["--user", "restart", svc], { timeout: 20000 }, () => {}), 250);
  });

  // ---- static SPA ----
  app.use(express.static(PUBLIC_DIR));
  app.get(/.*/, (req, res) => res.sendFile(join(PUBLIC_DIR, "index.html")));

  return app;
}

export async function startUi() {
  const { port, host, mdns } = uiSettings();
  const app = createApp();
  const token = ensureSetupToken();

  await new Promise((resolve) => {
    app.listen(port, host, () => resolve());
  });

  console.log("[ui] AeroAIRouter config UI listening on " + host + ":" + port);
  if (token) {
    console.log("\n  ╭───────────────────────────────────────────────╮");
    console.log("  │  FIRST-RUN SETUP CODE: " + token + "                  │");
    console.log("  │  Enter this in the web UI to create your admin │");
    console.log("  │  password and finish setup.                    │");
    console.log("  ╰───────────────────────────────────────────────╯\n");
  }
  console.log("[ui] Reachable at:");
  for (const u of accessUrls(port)) {
    console.log("       " + u.url + "  (" + u.kind + (u.iface ? "/" + u.iface : "") + ")");
  }
  if (mdns) await advertiseMdns(port);
}

// Allow running directly: `node src/ui/server.js`
if (process.argv[1] && process.argv[1].endsWith("server.js")) {
  startUi().catch((err) => {
    console.error("[ui] fatal:", err);
    process.exit(1);
  });
}
