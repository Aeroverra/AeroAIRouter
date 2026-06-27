// gogcli plugin. Wraps the `gog` binary (Google Workspace in your terminal) as an
// MCP server, and drives its install + OAuth entirely from the UI via `actions`
// (no SSH/CLI needed). Covers Gmail, Calendar, and Drive through one sign-in.
//
// All credentials live in gog's own config (~/.config/gogcli) + a file keyring
// unlocked by GOG_KEYRING_PASSWORD (stored as a plugin secret). The plugin stays
// idle until the binary is installed and the keyring password is set.
import { existsSync, writeFileSync, unlinkSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";
import { fileURLToPath } from "url";
import { randomBytes } from "crypto";

const __dir = dirname(fileURLToPath(import.meta.url));

export const meta = {
  name: "gog",
  label: "Google (gogcli)",
  description: "Gmail, Calendar, and Drive via the gogcli (gog) binary. One sign-in, set up from this page.",
};

export const enabledByDefault = true;
export const secrets = ["GOG_KEYRING_PASSWORD"];
export const defaults = { account: "", services: "gmail,calendar,drive" };
export const ui = "gogcli-setup"; // tells the UI to render the custom setup panel
export const configSchema = []; // handled by the custom panel

function resolveBin(home) {
  const cands = [home && join(home, "bin", "gog"), join(homedir(), ".local", "bin", "gog"), "/usr/local/bin/gog", "/usr/bin/gog"].filter(Boolean);
  for (const p of cands) if (existsSync(p)) return p;
  return "gog";
}

// ---- UI-driven setup actions (run in the UI process; ctx provided by server) ----
export const actions = {
  async status(_args, ctx) {
    const bin = resolveBin(ctx.home);
    const installed = bin !== "gog";
    const keyringSet = !!ctx.secret("GOG_KEYRING_PASSWORD");
    let version = "", accounts = [];
    if (installed) {
      const v = await ctx.exec(bin, ["version"], {});
      version = (v.stdout || "").trim().split("\n")[0];
      if (keyringSet) {
        const r = await ctx.exec(bin, ["--json", "auth", "list"], { env: { GOG_KEYRING_PASSWORD: ctx.secret("GOG_KEYRING_PASSWORD") } });
        try { const j = JSON.parse(r.stdout); accounts = (j.accounts || []).map((a) => ({ email: a.email, ok: !a.error })); } catch {}
      }
    }
    return { installed, binPath: installed ? bin : null, version, keyringSet, accounts };
  },

  async install(_args, ctx) {
    const script = join(ctx.installDir, "scripts", "install-gogcli.sh");
    const r = await ctx.exec("bash", [script], { env: { AIROUTER_HOME: ctx.home }, timeout: 180000 });
    if (r.code !== 0) throw new Error((r.stderr || r.stdout || "install failed").trim().slice(0, 400));
    const bin = resolveBin(ctx.home);
    const v = await ctx.exec(bin, ["version"], {});
    return { ok: true, version: (v.stdout || "").trim().split("\n")[0] };
  },

  async setCredentials({ clientJson }, ctx) {
    if (!clientJson || typeof clientJson !== "string") throw new Error("Paste the contents of your client_secret.json.");
    try { JSON.parse(clientJson); } catch { throw new Error("That isn't valid JSON."); }
    const bin = resolveBin(ctx.home);
    if (bin === "gog") throw new Error("Install gogcli first.");
    const tmp = join(ctx.home, ".gog-client-tmp.json");
    writeFileSync(tmp, clientJson, { mode: 0o600 });
    try {
      const r = await ctx.exec(bin, ["auth", "credentials", "set", tmp], {});
      if (r.code !== 0) throw new Error((r.stderr || r.stdout || "failed").trim().slice(0, 400));
    } finally { try { unlinkSync(tmp); } catch {} }
    return { ok: true };
  },

  async authStart({ email, services }, ctx) {
    if (!email) throw new Error("Enter the Google account email.");
    const bin = resolveBin(ctx.home);
    if (bin === "gog") throw new Error("Install gogcli first.");
    let pw = ctx.secret("GOG_KEYRING_PASSWORD");
    if (!pw) { pw = randomBytes(24).toString("base64url"); ctx.setSecrets({ GOG_KEYRING_PASSWORD: pw }); }
    const svc = services || "gmail,calendar,drive";
    const r = await ctx.exec(bin, ["--json", "auth", "add", email, "--remote", "--step", "1", "--services", svc, "--gmail-scope", "full", "--force-consent"], { env: { GOG_KEYRING_PASSWORD: pw }, timeout: 30000 });
    if (r.code !== 0) throw new Error((r.stderr || r.stdout || "failed").trim().slice(0, 400));
    let url = "";
    try { const j = JSON.parse(r.stdout); url = j.auth_url || j.authUrl || j.url || ""; } catch {}
    if (!url) { const m = (r.stdout + " " + r.stderr).match(/https:\/\/accounts\.google\.com\/[^\s"']+/); if (m) url = m[0]; }
    if (!url) throw new Error("Could not get an authorization URL from gog.");
    return { authUrl: url };
  },

  async authFinish({ email, redirectUrl, services }, ctx) {
    if (!email || !redirectUrl) throw new Error("Email and the redirect URL are required.");
    const pw = ctx.secret("GOG_KEYRING_PASSWORD");
    if (!pw) throw new Error("Start the sign-in first.");
    const bin = resolveBin(ctx.home);
    const svc = services || "gmail,calendar,drive";
    const r = await ctx.exec(bin, ["auth", "add", email, "--remote", "--step", "2", "--auth-url", String(redirectUrl).trim(), "--services", svc, "--force-consent"], { env: { GOG_KEYRING_PASSWORD: pw }, timeout: 60000 });
    if (r.code !== 0) throw new Error((r.stderr || r.stdout || "code exchange failed").trim().slice(0, 400));
    return { ok: true, account: email };
  },
};

// ---- MCP server launch (bot process) ----
export function mcp(ctx) {
  const home = ctx.config && ctx.config.airouterHome;
  const bin = resolveBin(home);
  const pw = ctx.secret("GOG_KEYRING_PASSWORD");
  // Idle until gog is installed (absolute path found) and the keyring is unlocked.
  if (bin === "gog" || !pw) return null;
  return {
    transport: "stdio",
    command: process.execPath,
    args: [join(__dir, "mcp", "index.js")],
    trust: "owner",
    env: {
      GOG_BIN: bin,
      GOG_KEYRING_PASSWORD: pw,
      GOG_ACCOUNT: (ctx.pluginConfig && ctx.pluginConfig.account) || "",
      PATH: process.env.PATH,
    },
  };
}
