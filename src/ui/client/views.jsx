import { useState, useEffect } from "preact/hooks";
import { api, setCsrf } from "./api.js";
import { S, buffers, getPath, setPath, deepMerge, toast, confirmDialog, promptDialog, registerDirty, clearDirty } from "./store.js";
import { afterAuth, reloadPlugins, refreshBotStatus, markSettingsDirty } from "./actions.js";
import { Btn, IconBtn, Icon, Field, TextInput, NumberInput, Select, Switch, Textarea, Card, Badge, StatusBadge, Chip, Spinner } from "./ui.jsx";
import { SchemaField, SecretInput, CheckResult, isScalar } from "./fields.jsx";

// ============================================================ LOGIN ==========
export function Login() {
  const [pw, setPw] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(e) {
    e.preventDefault(); setErr(""); setBusy(true);
    try { const r = await api("POST", "/api/login", { password: pw }); setCsrf(r.csrf); await afterAuth(); }
    catch (ex) { setErr(ex.message); setBusy(false); }
  }
  return (
    <div class="auth-screen">
      <form class="card card-pad auth-card" onSubmit={submit}>
        <div class="brand"><span class="logo" />AeroAIRouter</div>
        <p class="sub">Enter your admin password to continue.</p>
        <Field>
          <input class="input" type="password" placeholder="Password" autocomplete="current-password" value={pw} onInput={(e) => setPw(e.target.value)} autoFocus />
        </Field>
        {err && <p class="field-err">{err}</p>}
        <Btn variant="primary" class="btn-block" loading={busy} type="submit">Log in</Btn>
      </form>
    </div>
  );
}

// ============================================================ SETUP ==========
export function SetupWizard({ status }) {
  const needsPw = !!status.needsPassword;
  const [step, setStep] = useState(0);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [d, setD] = useState({
    setupCode: "", password: "", password2: "", DISCORD_TOKEN: "", ownerId: "", botName: "",
    authMode: "auto", ANTHROPIC_API_KEY: "", CLAUDE_CODE_OAUTH_TOKEN: "", BRAVE_API_KEY: "",
    model: "claude-opus-4-8", emoji: "", GITHUB_TOKEN: "", CLOUDFLARE_TOKEN: "", visibility: "private",
  });
  const [discordCheck, setDiscordCheck] = useState(null);
  const set = (k, v) => setD((o) => ({ ...o, [k]: v }));
  const link = (t, href) => <a href={href} target="_blank" rel="noopener">{t}</a>;

  const steps = [];
  if (needsPw) steps.push({
    title: "Admin password",
    body: <>
      <p class="muted" style="margin-bottom:12px">This password protects the control panel — you'll log in with it from now on.</p>
      <Field label="Setup code" hint="Printed in the server console / journal when the UI started."><TextInput value={d.setupCode} onInput={(v) => set("setupCode", v)} placeholder="paste the code from the server console" /></Field>
      <Field label="Admin password"><input class="input" type="password" value={d.password} onInput={(e) => set("password", e.target.value)} placeholder="at least 8 characters" /></Field>
      <Field label="Confirm password"><input class="input" type="password" value={d.password2} onInput={(e) => set("password2", e.target.value)} /></Field>
    </>,
    validate: () => (!d.password || d.password.length < 8) ? "Password must be at least 8 characters." : (d.password !== d.password2 ? "Passwords do not match." : null),
  });
  steps.push({
    title: "Discord bot",
    body: <>
      <p class="muted" style="margin-bottom:10px">Create a bot and paste its token. {link("Open the Discord Developer Portal ↗", "https://discord.com/developers/applications")}</p>
      <ol class="wiz-list">
        <li>New Application → Bot → Reset Token → Copy.</li>
        <li>Bot → Privileged Gateway Intents → enable MESSAGE CONTENT INTENT.</li>
        <li>OAuth2 → URL Generator → scope "bot", then invite it to your server.</li>
      </ol>
      <Field label="Discord bot token" hint="Click Test to verify it works.">
        <div class="input-wrap">
          <input class="input" type="password" placeholder="paste bot token" value={d.DISCORD_TOKEN} onInput={(e) => set("DISCORD_TOKEN", e.target.value)} />
          <Btn variant="secondary" onClick={async () => { const t = d.DISCORD_TOKEN.trim(); if (!t) { setDiscordCheck({ ok: false, error: "Enter a token first" }); return; } setDiscordCheck({ loading: true }); try { const r = await api("POST", "/api/check-discord", { token: t }); setDiscordCheck(r.ok ? { ok: true, username: r.username } : { ok: false, error: r.error }); } catch (ex) { setDiscordCheck({ ok: false, error: ex.message }); } }}>Test</Btn>
        </div>
      </Field>
      {discordCheck && (discordCheck.loading ? <p class="hint"><Spinner size={12} /> Checking…</p> : <p class={discordCheck.ok ? "status ok" : "status err"}><span class="dot" />{discordCheck.ok ? "Valid — " + discordCheck.username : discordCheck.error}</p>)}
      <Field label="Bot name" hint="Used as the wake word in busy channels and voice."><TextInput value={d.botName} onInput={(v) => set("botName", v)} placeholder="e.g. Azula" /></Field>
      <Field label="Your Discord user ID" hint="Discord → Settings → Advanced → Developer Mode ON, then right-click your name → Copy User ID."><TextInput value={d.ownerId} onInput={(v) => set("ownerId", v)} placeholder="your user ID" /></Field>
    </>,
    validate: () => (!d.DISCORD_TOKEN.trim() ? "Discord bot token is required." : (!d.ownerId.trim() ? "Your Discord user ID is required." : null)),
  });
  steps.push({
    title: "Claude",
    body: <>
      <p class="muted" style="margin-bottom:10px">How the bot talks to Claude — a standard API key, or your Claude subscription via an OAuth token.</p>
      <Field label="Auth mode"><Select value={d.authMode} options={[["auto", "Auto (API key if set, else OAuth)"], ["apikey", "API key"], ["oauth", "OAuth setup-token"]]} onInput={(v) => set("authMode", v)} /></Field>
      <Field label="Anthropic API key" hint={<>Create one at {link("console.anthropic.com ↗", "https://console.anthropic.com/settings/keys")}.</>}><input class="input" type="password" placeholder="sk-ant-…" value={d.ANTHROPIC_API_KEY} onInput={(e) => set("ANTHROPIC_API_KEY", e.target.value)} /></Field>
      <Field label="Claude OAuth setup-token" hint={<>Run <code>claude setup-token</code> in a terminal — uses your Claude subscription.</>}><input class="input" type="password" placeholder="sk-ant-oat01-…" value={d.CLAUDE_CODE_OAUTH_TOKEN} onInput={(e) => set("CLAUDE_CODE_OAUTH_TOKEN", e.target.value)} /></Field>
      <Field label="Model"><TextInput value={d.model} onInput={(v) => set("model", v)} placeholder="claude-opus-4-8" /></Field>
    </>,
    validate: () => {
      if (!d.ANTHROPIC_API_KEY.trim() && !d.CLAUDE_CODE_OAUTH_TOKEN.trim()) return "Provide an Anthropic API key OR an OAuth setup-token.";
      if (d.authMode === "oauth" && !d.CLAUDE_CODE_OAUTH_TOKEN.trim()) return "OAuth mode needs the setup-token.";
      if (d.authMode === "apikey" && !d.ANTHROPIC_API_KEY.trim()) return "API-key mode needs the API key.";
      return null;
    },
  });
  steps.push({
    title: "Integrations (optional)",
    body: <>
      <p class="muted" style="margin-bottom:10px">Optional credentials. Skip any you don't need — add more later under Plugins.</p>
      <Field label="Brave Search API key" hint={<>Free key at {link("brave.com/search/api ↗", "https://brave.com/search/api/")}.</>}><input class="input" type="password" placeholder="enables web search" value={d.BRAVE_API_KEY} onInput={(e) => set("BRAVE_API_KEY", e.target.value)} /></Field>
      <Field label="GitHub token" hint={<>Create at {link("github.com/settings/tokens ↗", "https://github.com/settings/tokens")}.</>}><input class="input" type="password" placeholder="ghp_… / github_pat_…" value={d.GITHUB_TOKEN} onInput={(e) => set("GITHUB_TOKEN", e.target.value)} /></Field>
      <Field label="New GitHub repos default to"><Select value={d.visibility} options={[["private", "Private"], ["public", "Public"]]} onInput={(v) => set("visibility", v)} /></Field>
      <Field label="Cloudflare API token" hint={<>Create at {link("Cloudflare → API Tokens ↗", "https://dash.cloudflare.com/profile/api-tokens")}.</>}><input class="input" type="password" placeholder="optional" value={d.CLOUDFLARE_TOKEN} onInput={(e) => set("CLOUDFLARE_TOKEN", e.target.value)} /></Field>
    </>,
  });
  steps.push({
    title: "Finish",
    body: <>
      <p class="muted" style="margin-bottom:10px">Last touches, then save. Configure channels in the Discord tab afterward.</p>
      <Field label="Signature emoji" hint="Appended to messages. Leave blank for none."><TextInput value={d.emoji} onInput={(v) => set("emoji", v)} placeholder="e.g. a custom emoji, or blank" /></Field>
    </>,
  });

  async function finish() {
    setErr("");
    for (const s of steps) { const v = s.validate && s.validate(); if (v) { setErr(v); return; } }
    setBusy(true);
    try {
      const patch = {};
      const put = (p, v) => { if (v !== "" && v !== undefined) setPath(patch, p, v); };
      put("discord.wakeWord", d.botName.trim());
      put("discord.ownerId", d.ownerId.trim());
      put("ai.auth.mode", d.authMode);
      if (d.model.trim()) { put("ai.models.complex", d.model.trim()); put("ai.models.casual", d.model.trim()); }
      setPath(patch, "persona.emoji", d.emoji);
      if (d.ownerId.trim()) setPath(patch, "discord.people." + d.ownerId.trim(), { name: "Owner", trust: "owner" });
      setPath(patch, "plugins.config.github.defaultVisibility", d.visibility);
      const secrets = {};
      for (const k of ["DISCORD_TOKEN", "ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "BRAVE_API_KEY", "GITHUB_TOKEN", "CLOUDFLARE_TOKEN"]) if (d[k] && d[k].trim()) secrets[k] = d[k].trim();
      const res = await api("POST", "/api/setup", { setupCode: d.setupCode.trim() || undefined, password: needsPw ? d.password : undefined, config: patch, secrets });
      setCsrf(res.csrf); toast("Setup complete"); await afterAuth();
    } catch (ex) { setErr(ex.message); setBusy(false); }
  }
  function go(delta) { if (delta > 0) { const v = steps[step].validate && steps[step].validate(); if (v) { setErr(v); return; } } setErr(""); setStep((s) => Math.max(0, Math.min(steps.length - 1, s + delta))); }

  const cur = steps[step];
  return (
    <div class="auth-screen">
      <div class="card card-pad wizard">
        <div class="brand" style="margin-bottom:6px"><span class="logo" />Set up AeroAIRouter</div>
        <div class="wiz-steps">{steps.map((s, i) => <span class={`s ${i === step ? "active" : i < step ? "done" : ""}`} />)}</div>
        <div class="wiz-label">Step {step + 1} of {steps.length} — {cur.title}</div>
        <div class="wiz-body">{cur.body}</div>
        {err && <p class="field-err">{err}</p>}
        <div class="wiz-nav">
          {step > 0 && <Btn variant="ghost" onClick={() => go(-1)}>← Back</Btn>}
          <span class="spacer" />
          {step < steps.length - 1 ? <Btn variant="primary" onClick={() => go(1)}>Next →</Btn> : <Btn variant="primary" loading={busy} onClick={finish}>Finish</Btn>}
        </div>
      </div>
    </div>
  );
}

// ============================================================ DASHBOARD ======
export function Dashboard({ navigate }) {
  const cfg = S.config.value;
  const plugins = S.plugins.value;
  const enabled = plugins.filter((p) => p.enabled && !p.uninstalled);
  const installed = plugins.filter((p) => !p.uninstalled);
  const channels = (getPath(cfg, "discord.channels") || []).length;
  const model = getPath(cfg, "ai.models.complex") || "—";
  const authMode = getPath(cfg, "ai.auth.mode") || "auto";
  const sec = S.secrets.value;
  const [mcp, setMcp] = useState(null);
  useEffect(() => { api("GET", "/api/mcp").then(setMcp).catch(() => setMcp({ servers: [], error: true })); refreshBotStatus(); }, []);

  const toolCount = mcp ? (mcp.servers || []).reduce((n, s) => n + (s.tools || []).length, 0) : null;
  const connected = mcp ? (mcp.servers || []).filter((s) => s.status === "connected").length : 0;
  const pill = S.botStatus.value;

  const check = (ok, label, route) => (
    <li><span class={`ck ${ok ? "done" : "todo"}`}>{ok ? "✓" : "!"}</span><span>{label}</span>
      <Btn class="go" variant="ghost" size="sm" onClick={() => navigate(route)}>{ok ? "view" : "set up"}</Btn></li>
  );

  return (
    <div>
      <div class="dash-hero">
        <div>
          <h1>Dashboard</h1>
          <p class="muted">Bot service: <span class={`status ${pill === "active" ? "ok" : pill === "?" || pill === "…" ? "idle" : "warn"}`}><span class="dot" />{pill}</span></p>
        </div>
        <Btn variant="primary" icon="restart" onClick={restartBot}>Restart bot</Btn>
      </div>

      <div class="stat-grid">
        <Stat num={channels} label="Channels watched" sub={channels === 1 ? "1 channel" : channels + " channels"} />
        <Stat num={enabled.length} label="Plugins active" sub={installed.length + " installed"} brand />
        <Stat num={toolCount == null ? "…" : toolCount} label="MCP tools" sub={mcp ? `${connected}/${(mcp.servers || []).length} servers connected` : "loading"} />
        <Stat num={authMode} label="Claude auth" sub={model} />
      </div>

      <Card class="card-pad" style="margin-bottom:16px">
        <h3 style="margin-bottom:10px">Connections</h3>
        {!mcp ? <p class="hint"><Spinner size={13} /> Loading…</p> : (mcp.servers || []).length === 0 ? <p class="hint">No MCP servers yet. Enable a plugin or add one under MCP Servers.</p> : <>
          {!mcp.botRunning && <p class="hint" style="margin-bottom:6px">Live status appears once the bot has started with these settings.</p>}
          {(mcp.servers || []).map((s) => (
            <div class="health-row"><StatusBadge status={s.status} error={s.error} /><span class="h-name">{s.label || s.name}</span><span class="h-meta">{(s.tools || []).length} tools{s.managed ? " · plugin" : ""}</span></div>
          ))}
        </>}
      </Card>

      <Card class="card-pad">
        <h3 style="margin-bottom:10px">Setup checklist</h3>
        <ul class="checklist">
          {check(!!sec.DISCORD_TOKEN, "Discord bot token", "essentials")}
          {check(!!(sec.ANTHROPIC_API_KEY || sec.CLAUDE_CODE_OAUTH_TOKEN), "Claude credential", "essentials")}
          {check(!!getPath(cfg, "discord.ownerId"), "Owner user ID", "essentials")}
          {check(channels > 0, "At least one channel", "discord")}
        </ul>
      </Card>
    </div>
  );
}
const Stat = ({ num, label, sub, brand }) => (
  <div class="stat"><div class={`num ${brand ? "brand" : ""}`}>{num}</div><div class="lbl">{label}</div><div class="sub">{sub || ""}</div></div>
);

// ============================================================ SETTINGS =======
export function SchemaSection({ section }) {
  const adv = S.advanced.value;
  const fields = section.fields.filter((f) => !(f.advanced && !adv));
  // partition into runs: scalar runs become a 2-col grid; editors are full-width.
  const blocks = [];
  let curGroup = null;
  for (const f of fields) {
    if (f.group && f.group !== curGroup) { curGroup = f.group; blocks.push({ seg: f.group }); }
    if (isScalar(f)) {
      const last = blocks[blocks.length - 1];
      if (last && last.grid) last.items.push(f); else blocks.push({ grid: true, items: [f] });
    } else blocks.push({ full: f });
  }
  return (
    <div>
      <div class="page-head"><h1>{section.title}</h1>{section.help && <p class="sub">{section.help}</p>}</div>
      {blocks.map((b) => b.seg ? <div class="seg"><h3>{b.seg}</h3></div>
        : b.grid ? <div class="field-grid">{b.items.map((f) => <SchemaField f={f} />)}</div>
        : <SchemaField f={b.full} />)}
      {section.id === "network" && <NetworkExtras />}
    </div>
  );
}

function NetworkExtras() {
  const [urls, setUrls] = useState(null);
  useEffect(() => { api("GET", "/api/netinfo").then((r) => setUrls(r.urls || [])).catch(() => setUrls([])); }, []);
  return <>
    <div class="seg"><h3>Apply changes</h3></div>
    <p class="hint" style="margin-bottom:10px">Save first, then apply. Applying restarts the UI — reconnect at the new address/port if you changed it.</p>
    <Btn variant="secondary" icon="restart" onClick={restartUi}>Apply network changes (restart UI)</Btn>
    <div class="seg"><h3>Access &amp; URLs</h3></div>
    <Card class="card-pad">
      {urls == null ? <p class="hint"><Spinner size={13} /> Loading…</p> :
        <ul class="url-list">{urls.map((u) => <li><a href={u.url} target="_blank" rel="noopener">{u.url}</a><Badge>{u.kind}{u.iface ? " · " + u.iface : ""}</Badge></li>)}</ul>}
    </Card>
  </>;
}

// ============================================================ RAW =============
export function RawJson() {
  const [text, setText] = useState(JSON.stringify(S.config.value, null, 2));
  const [err, setErr] = useState("");
  return (
    <div>
      <div class="page-head"><h1>Raw config.json</h1><p class="sub">Edit the full config object. Secrets are never stored here.</p></div>
      <Textarea code value={text} style="min-height:440px" class={err ? "bad" : ""}
        onInput={(v) => { setText(v); try { S.config.value = JSON.parse(v); setErr(""); markSettingsDirty(); } catch (ex) { setErr(ex.message); } }} />
      {err && <p class="field-err">{err}</p>}
    </div>
  );
}

// ============================================================ ACTIONS ========
export async function restartBot() {
  if (!(await confirmDialog({ title: "Restart bot", message: "Restart the bot service now? It'll be briefly offline.", confirmLabel: "Restart" }))) return;
  try { await api("POST", "/api/bot/restart"); toast("Bot restarting…"); setTimeout(refreshBotStatus, 4000); } catch (ex) { toast(ex.message, "bad"); }
}
export async function restartUi() {
  if (!(await confirmDialog({ title: "Restart UI", message: "Restart the config UI now? You may need to reconnect at a new address/port.", confirmLabel: "Restart" }))) return;
  try { await api("POST", "/api/ui/restart"); toast("UI restarting… reconnect if the address/port changed."); } catch (ex) { toast(ex.message, "bad"); }
}
export async function changePassword() {
  await promptDialog({
    title: "Change admin password",
    fields: [
      { name: "current", label: "Current password", type: "password" },
      { name: "next", label: "New password", type: "password", hint: "At least 8 characters." },
      { name: "confirm", label: "Confirm new password", type: "password" },
    ],
    confirmLabel: "Change password",
    validate: (v) => (!v.current ? "Enter your current password." : (!v.next || v.next.length < 8 ? "New password must be at least 8 characters." : (v.next !== v.confirm ? "New passwords don't match." : null))),
    onConfirm: async (v) => { await api("PUT", "/api/password", { current: v.current, next: v.next }); toast("Password changed — the UI is restarting, log back in."); },
  });
}
