// Camoufox plugin. Wraps Camoufox (an anti-detect Firefox) as a small MCP server
// so the bot can fetch pages that block the normal web_fetch tool — Cloudflare, JS
// challenges, 403/429 bot walls. Camoufox ships a ~500MB patched Firefox, so it is
// installed on demand via the "Install" button on this plugin's setup panel (like
// the gog plugin), into a private Python venv under AIROUTER_HOME. The plugin stays
// idle until that venv exists, so the bot boots fine before it's installed.
import { existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dir = dirname(fileURLToPath(import.meta.url));

export const meta = {
  name: "camoufox",
  label: "Camoufox",
  description: "Stealth-browser fallback for anti-bot-protected sites. When web_fetch is blocked (Cloudflare / JS challenge), retry the URL with camoufox__fetch_url.",
};

export const enabledByDefault = true;
export const defaults = { headless: true, waitMs: 3500, maxLength: 20000 };
export const ui = "camoufox-setup"; // custom install/setup panel (see src/ui/client/plugins.jsx)
export const configSchema = []; // handled by the custom panel; defaults above apply

// The venv the Install button creates. camoufox + its Firefox binary live here.
function venvPython(home) {
  return join(home || "", "camoufox-venv", "bin", "python");
}

// ---- UI-driven install actions (run in the UI process; ctx provided by server) ----
export const actions = {
  async status(_args, ctx) {
    const py = venvPython(ctx.home);
    if (!existsSync(py)) return { installed: false, version: "" };
    const v = await ctx.exec(py, ["-c", "import importlib.metadata as m;print(m.version('camoufox'))"], { timeout: 20000 });
    const version = v.code === 0 ? ((v.stdout || "").trim().split("\n").pop() || "") : "";
    return { installed: !!version, version };
  },

  async install(_args, ctx) {
    const script = join(ctx.installDir, "scripts", "install-camoufox.sh");
    const r = await ctx.exec("bash", [script], { env: { AIROUTER_HOME: ctx.home }, timeout: 900000 });
    const out = (r.stdout || "") + "\n" + (r.stderr || "");
    if (r.code !== 0) throw new Error((r.stderr || r.stdout || "install failed").trim().slice(-500));
    const mVer = out.match(/STATUS: ok version=(\S+)/);
    const mDeps = out.match(/SYSTEM_DEPS: (missing[^\n]*)/);
    return { ok: true, version: mVer ? mVer[1] : "installed", sysdeps: mDeps ? mDeps[1].trim() : "ok", log: out.trim().slice(-1200) };
  },

  async uninstall(_args, ctx) {
    await ctx.exec("rm", ["-rf", join(ctx.home || "", "camoufox-venv")], { timeout: 30000 });
    return { ok: true };
  },
};

// ---- MCP server launch (bot process) ----
export function mcp(ctx) {
  const home = ctx.config && ctx.config.airouterHome;
  const py = venvPython(home);
  // Idle until installed (venv python present). UI shows "not installed — Install".
  if (!existsSync(py)) return null;
  const cfg = ctx.pluginConfig || {};
  return {
    transport: "stdio",
    command: py,
    args: [join(__dir, "mcp", "server.py")],
    trust: "owner",
    env: {
      CAMOUFOX_HEADLESS: cfg.headless === false ? "0" : "1",
      CAMOUFOX_WAIT_MS: String(cfg.waitMs || 3500),
      CAMOUFOX_MAXLEN: String(cfg.maxLength || 20000),
      PATH: process.env.PATH,
      HOME: process.env.HOME || home,
    },
  };
}
