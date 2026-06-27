import { useState, useEffect, useRef } from "preact/hooks";
import { api } from "./api.js";
import { S, toast, confirmDialog, registerDirty } from "./store.js";
import { reloadPlugins, refreshBotStatus } from "./actions.js";
import { restartBot } from "./views.jsx";
import { Btn, IconBtn, Icon, Field, TextInput, NumberInput, Select, Switch, Textarea, Card, Badge, StatusBadge, Spinner } from "./ui.jsx";
import { SecretInput, CheckResult } from "./fields.jsx";

const configurable = (p) => !!((p.configSchema || []).length || p.ui || p.hasCheckToken);

// ============================================================ LIST ===========
export function PluginsList({ navigate }) {
  const list = S.plugins.value;
  const installed = list.filter((p) => !p.uninstalled);
  const available = list.filter((p) => p.uninstalled);
  return (
    <div>
      <div class="page-head"><h1>Plugins</h1><p class="sub">Turn plugins on or off, configure them, or uninstall. Configurable plugins also appear in the menu on the left. Restart the bot to apply changes.</p></div>
      {!installed.length && <p class="empty">No plugins installed.</p>}
      <div class="rows">{installed.map((p) => <PluginCard p={p} navigate={navigate} />)}</div>
      {available.length > 0 && <>
        <div class="seg"><h3>Available to reinstall</h3></div>
        <div class="rows">{available.map((p) => (
          <Card class="card-pad dim">
            <div class="row"><strong>{p.label || p.name}</strong>{p.bundled && <Badge>bundled</Badge>}<span class="spacer" />
              <Btn variant="secondary" onClick={async () => { try { await api("POST", "/api/plugins/" + p.name + "/reinstall"); toast("Reinstalled " + (p.label || p.name) + ". Restart the bot to apply."); await reloadPlugins(); } catch (ex) { toast(ex.message, "bad"); } }}>Reinstall</Btn>
            </div>
            {p.description && <p class="hint" style="margin-top:6px">{p.description}</p>}
          </Card>
        ))}</div>
      </>}
    </div>
  );
}

function PluginCard({ p, navigate }) {
  const [enabled, setEnabled] = useState(!!p.enabled);
  async function toggle(v) {
    setEnabled(v);
    try { await api("PUT", "/api/plugins/" + p.name, { enabled: v }); p.enabled = v; toast((v ? "Enabled " : "Disabled ") + (p.label || p.name) + ". Restart the bot to apply."); }
    catch (ex) { setEnabled(!v); toast(ex.message, "bad"); }
  }
  async function uninstall() {
    const hasCreds = p.secretKeys && p.secretKeys.length;
    const ok = await confirmDialog({ title: "Uninstall " + (p.label || p.name) + "?", danger: true, confirmLabel: "Uninstall",
      message: "This disables it and clears its saved settings" + (hasCreds ? " and stored credentials" : "") + "." + (p.bundled ? " You can reinstall it later." : "") });
    if (!ok) return;
    try { await api("DELETE", "/api/plugins/" + p.name); toast("Uninstalled " + (p.label || p.name) + "."); await reloadPlugins(); } catch (ex) { toast(ex.message, "bad"); }
  }
  return (
    <Card class="card-pad">
      <div class="row">
        <strong>{p.label || p.name}</strong>
        {p.hasMcp && <Badge kind="brand">MCP</Badge>}
        {p.bundled && <Badge>bundled</Badge>}
        {p.broken && <Badge kind="danger">error</Badge>}
        <span class="spacer" />
        <Switch checked={enabled} onChange={toggle} label={enabled ? "enabled" : "disabled"} />
      </div>
      {p.description && <p class="hint" style="margin-top:6px">{p.description}</p>}
      {p.broken && <p class="field-err">{p.error || "failed to load"}</p>}
      <div class="card-actions" style="margin:12px -20px -16px;padding-left:20px;padding-right:20px">
        {configurable(p) && <Btn variant="secondary" onClick={() => navigate("__plugin:" + p.name)}>{p.ui ? "Set up →" : "Configure →"}</Btn>}
        <span class="spacer" />
        <Btn variant="danger" onClick={uninstall}>Uninstall</Btn>
      </div>
    </Card>
  );
}

// ============================================================ CONFIG =========
export function PluginConfig({ name, navigate }) {
  const p = S.plugins.value.find((x) => x.name === name);
  if (!p) return <div><Btn variant="ghost" onClick={() => navigate("__plugins")}>← All plugins</Btn><p class="field-err">Plugin not found.</p></div>;
  if (p.ui === "gogcli-setup") return <GogSetup p={p} navigate={navigate} />;

  const ref = useRef(null);
  if (!ref.current || ref.current.name !== name) ref.current = { name, conf: Object.assign({}, p.defaults || {}, p.config || {}), secretEdits: {}, enabled: !!p.enabled };
  const st = ref.current;
  const [, force] = useState(0); const rerender = () => force((n) => n + 1);

  function markDirty() {
    registerDirty("plugin:" + name, { label: p.label || name, save: async () => {
      await api("PUT", "/api/plugins/" + name, { enabled: st.enabled, config: st.conf });
      const sec = {};
      for (const [k, v] of Object.entries(st.secretEdits)) { if (v === null) sec[k] = null; else if (v && v.trim()) sec[k] = v.trim(); }
      if (Object.keys(sec).length) await api("PUT", "/api/secrets", { secrets: sec });
      await reloadPlugins();
    } });
  }

  return (
    <div>
      <Btn variant="ghost" onClick={() => navigate("__plugins")}>← All plugins</Btn>
      <div class="page-head" style="margin-top:8px"><h1>{p.label || p.name}</h1>{p.description && <p class="sub">{p.description}</p>}</div>
      {p.broken ? <p class="field-err">{p.error || "failed to load"}</p> : <>
        <Field><Switch checked={st.enabled} onChange={(v) => { st.enabled = v; markDirty(); rerender(); }} label="plugin enabled" /></Field>
        {(p.configSchema || []).map((f) => <PluginField f={f} st={st} pluginName={name} onChange={() => { markDirty(); rerender(); }} />)}
        {p.hasCheckToken && !(p.configSchema || []).some((f) => f.type === "tokens") && <TestConnection name={name} />}
      </>}
    </div>
  );
}

function PluginField({ f, st, pluginName, onChange }) {
  const secrets = S.pluginSecrets.value;
  if (f.type === "tokens") return <PluginTokensField f={f} st={st} pluginName={pluginName} onChange={onChange} />;
  if (f.secret) {
    return <Field label={f.label} hint={f.help}>
      <SecretInput present={!!secrets[f.secret]} revealKey={f.secret} onInput={(v) => { st.secretEdits[f.secret] = v; onChange(); }} />
    </Field>;
  }
  const val = st.conf[f.path];
  const set = (v) => { st.conf[f.path] = v; onChange(); };
  if (f.type === "boolean") return <Field label={f.label} hint={f.help}><Switch checked={!!val} onChange={set} label={val ? "on" : "off"} /></Field>;
  if (f.type === "select") return <Field label={f.label} hint={f.help}><Select value={val == null ? f.options[0] : val} options={f.options} onInput={set} /></Field>;
  if (f.type === "number") return <Field label={f.label} hint={f.help}><NumberInput value={val} onInput={set} /></Field>;
  return <Field label={f.label} hint={f.help}><TextInput value={val == null ? "" : String(val)} onInput={set} /></Field>;
}

function PluginTokensField({ f, st, pluginName, onChange }) {
  const prefix = f.keyPrefix || "TOKEN";
  const secrets = S.pluginSecrets.value;
  const ref = useRef(null);
  if (!ref.current) {
    const rows = Array.isArray(st.conf[f.path]) ? st.conf[f.path].map((t) => ({ ...t })) : [];
    if (!rows.length) rows.push({ label: "default", key: prefix });
    ref.current = rows;
  }
  const rows = ref.current;
  const [, force] = useState(0); const rerender = () => force((n) => n + 1);
  const [checks, setChecks] = useState({});

  function ensureKey(r, idx) { if (r.key) return; if (idx === 0) { r.key = prefix; return; } const slug = (r.label || "").toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, ""); r.key = prefix + "_" + (slug || (idx + 1)); }
  function commit() { st.conf[f.path] = rows.filter((r) => r.key).map((r) => ({ label: r.label || r.key, key: r.key })); onChange(); }
  async function check(r, typed) {
    setChecks((c) => ({ ...c, [r.key]: { loading: true } }));
    try { const body = typed && typed.trim() ? { token: typed.trim() } : { key: r.key }; const res = await api("POST", "/api/plugins/" + pluginName + "/check-token", body); setChecks((c) => ({ ...c, [r.key]: { res } })); }
    catch (ex) { setChecks((c) => ({ ...c, [r.key]: { res: { ok: false, error: ex.message } } })); }
  }

  return (
    <Field label={f.label} hint={f.help}>
      <div class="rows">
        {rows.map((r, idx) => { ensureKey(r, idx); const typedRef = { v: "" }; const ck = checks[r.key];
          return (
            <Card class="card-pad">
              <div class="row">
                <TextInput class="grow" placeholder="label (e.g. read-only)" value={r.label || ""} onInput={(v) => { r.label = v; commit(); }} />
                <IconBtn name="trash" label="Remove token" onClick={() => { st.secretEdits[r.key] = null; rows.splice(idx, 1); commit(); rerender(); }} />
              </div>
              <div class="input-wrap" style="margin-top:8px">
                <input class="input" type="password" placeholder={secrets[r.key] ? "•••••• (leave blank to keep)" : "paste token"} onInput={(e) => { st.secretEdits[r.key] = e.target.value; typedRef.v = e.target.value; }} />
                <Btn variant="secondary" size="sm" loading={ck && ck.loading} onClick={() => check(r, typedRef.v)}>Check</Btn>
              </div>
              <p class="hint">env var: <code>{r.key}</code></p>
              {ck && ck.res && <CheckResult res={ck.res} />}
            </Card>
          );
        })}
        <div><Btn variant="ghost" size="sm" icon="plus" onClick={() => { rows.push({ label: "", key: "" }); commit(); rerender(); }}>Add token</Btn></div>
      </div>
    </Field>
  );
}

function TestConnection({ name }) {
  const [st, setSt] = useState(null);
  async function run() { setSt({ loading: true }); try { const res = await api("POST", "/api/plugins/" + name + "/check-token", {}); setSt({ res }); } catch (ex) { setSt({ res: { ok: false, error: ex.message } }); } }
  return (
    <div style="margin-top:14px">
      <Btn variant="secondary" loading={st && st.loading} onClick={run}>Test connection</Btn>
      {st && st.res && <CheckResult res={st.res} />}
      <p class="hint" style="margin-top:8px">Tests the last SAVED credentials — save first if you just entered them.</p>
    </div>
  );
}

// ============================================================ GOG SETUP ======
function GogSetup({ p, navigate }) {
  const [stt, setStt] = useState(null);
  const [err, setErr] = useState(null);
  async function refresh() { try { setStt(await api("POST", "/api/plugins/" + p.name + "/action/status", {})); setErr(null); } catch (ex) { setErr(ex.message); } }
  useEffect(() => { refresh(); }, []);
  return (
    <div>
      <Btn variant="ghost" onClick={() => navigate("__plugins")}>← All plugins</Btn>
      <div class="page-head" style="margin-top:8px"><h1>{p.label || "Google (gogcli)"}</h1><p class="sub">Set up Google access (Gmail, Calendar, Drive) entirely here. Restart the bot after you connect an account.</p></div>
      {err && <p class="field-err">{err}</p>}
      {!stt ? <p class="hint"><Spinner size={13} /> Loading…</p> : <GogSteps p={p} stt={stt} refresh={refresh} />}
    </div>
  );
}
function GogSteps({ p, stt, refresh }) {
  const act = (a, b) => api("POST", "/api/plugins/" + p.name + "/action/" + a, b || {});
  return <div class="rows">
    {/* 1. install */}
    <Card class="card-pad">
      <h3 style="margin-bottom:8px">1. Install gogcli</h3>
      {stt.installed ? <p class="status ok"><span class="dot" />Installed {stt.version || ""}</p> : <GogInstall act={act} refresh={refresh} />}
    </Card>
    {/* 2. credentials */}
    <Card class="card-pad" dim={!stt.installed}>
      <h3 style="margin-bottom:8px">2. Google OAuth client</h3>
      <p class="hint" style="margin-bottom:8px">Create a Desktop OAuth client at <a href="https://console.cloud.google.com/auth/clients" target="_blank" rel="noopener">Google Cloud → Credentials ↗</a>. Enable the Gmail/Calendar/Drive APIs, set the consent screen to Production, then paste the downloaded client_secret.json below.</p>
      <GogCreds act={act} />
    </Card>
    {/* 3. connect */}
    <Card class="card-pad" dim={!stt.installed}>
      <h3 style="margin-bottom:8px">3. Connect a Google account</h3>
      <GogConnect act={act} refresh={refresh} stt={stt} />
      {stt.accounts && stt.accounts.length > 0 && <p class="status ok" style="margin-top:8px"><span class="dot" />Connected: {stt.accounts.map((a) => a.email + (a.ok ? "" : " (token error — reconnect)")).join(", ")}</p>}
    </Card>
    {/* 4. enable */}
    <Card class="card-pad">
      <h3 style="margin-bottom:8px">4. Enable</h3>
      <GogEnable p={p} stt={stt} />
    </Card>
  </div>;
}
function GogInstall({ act, refresh }) {
  const [busy, setBusy] = useState(false); const [out, setOut] = useState("");
  return <>
    <p class="hint" style="margin-bottom:8px">Downloads the gog binary for this server (~14MB). No Go toolchain needed.</p>
    <div class="row"><Btn variant="primary" loading={busy} onClick={async () => { setBusy(true); setOut("Installing…"); try { const r = await act("install"); setOut("✓ " + (r.version || "installed")); refresh(); } catch (ex) { setOut("✗ " + ex.message); setBusy(false); } }}>Install gogcli</Btn><span class="hint">{out}</span></div>
  </>;
}
function GogCreds({ act }) {
  const [json, setJson] = useState(""); const [out, setOut] = useState("");
  return <>
    <Textarea code value={json} placeholder='{"installed":{"client_id":"…","client_secret":"…"}}' style="min-height:90px" onInput={setJson} />
    <div class="row" style="margin-top:8px"><Btn variant="secondary" onClick={async () => { setOut("Saving…"); try { await act("setCredentials", { clientJson: json }); setOut("✓ saved"); setJson(""); } catch (ex) { setOut("✗ " + ex.message); } }}>Save credentials</Btn><span class="hint">{out}</span></div>
  </>;
}
function GogConnect({ act, refresh, stt }) {
  const [email, setEmail] = useState(stt.accounts && stt.accounts[0] ? stt.accounts[0].email : "");
  const [flow, setFlow] = useState(null); const [redir, setRedir] = useState(""); const [out, setOut] = useState("");
  async function start() {
    if (!email.trim()) { toast("Enter an email first", "bad"); return; }
    setFlow({ loading: true });
    try { const r = await act("authStart", { email: email.trim() }); setFlow({ url: r.authUrl }); } catch (ex) { setFlow({ error: ex.message }); }
  }
  return <>
    <Field label="Account email"><TextInput value={email} onInput={setEmail} placeholder="you@gmail.com" /></Field>
    <Btn variant="primary" loading={flow && flow.loading} onClick={start}>Start sign-in</Btn>
    {flow && flow.error && <p class="field-err">{flow.error}</p>}
    {flow && flow.url && <div style="margin-top:10px">
      <p>1) <a href={flow.url} target="_blank" rel="noopener">Open Google sign-in ↗</a> and approve access.</p>
      <p class="hint">2) Your browser lands on a http://127.0.0.1:… page that fails to load — that's expected. Copy the full URL from the address bar and paste it below.</p>
      <Field label="Redirect URL"><TextInput value={redir} onInput={setRedir} placeholder="http://127.0.0.1:…/oauth2/callback?code=…" /></Field>
      <div class="row"><Btn variant="primary" onClick={async () => { setOut("Connecting…"); try { await act("authFinish", { email: email.trim(), redirectUrl: redir }); setOut("✓ connected"); toast("Connected " + email.trim()); refresh(); } catch (ex) { setOut("✗ " + ex.message); } }}>Finish connecting</Btn><span class="hint">{out}</span></div>
    </div>}
  </>;
}
function GogEnable({ p, stt }) {
  const ready = stt.installed && stt.keyringSet && (stt.accounts || []).some((a) => a.ok);
  const [enabled, setEnabled] = useState(!!p.enabled);
  const [acct, setAcct] = useState((p.config && p.config.account) || "");
  const [out, setOut] = useState("");
  return <>
    <Field><Switch checked={enabled} onChange={setEnabled} label="plugin enabled" /></Field>
    {(stt.accounts || []).length > 1 && <Field label="Use account"><Select value={acct} options={[["", "(default account)"], ...stt.accounts.map((a) => [a.email, a.email])]} onInput={setAcct} /></Field>}
    <div class="row">
      <Btn variant="primary" onClick={async () => { try { const cfg = Object.assign({}, p.config || {}); if (acct) cfg.account = acct; await api("PUT", "/api/plugins/" + p.name, { enabled, config: cfg }); p.enabled = enabled; p.config = cfg; setOut("✓ saved"); toast("Saved. Restart the bot to apply."); await reloadPlugins(); } catch (ex) { setOut("✗ " + ex.message); } }}>Save</Btn>
      <Btn variant="secondary" icon="restart" onClick={restartBot}>Restart bot</Btn>
      <span class="hint">{out}</span>
    </div>
    {!ready && <p class="hint" style="margin-top:8px">Finish steps 1–3, then enable and restart the bot.</p>}
  </>;
}

// ============================================================ MCP =============
export function McpView() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const ref = useRef(null);
  const [, force] = useState(0); const rerender = () => force((n) => n + 1);
  useEffect(() => {
    api("GET", "/api/mcp").then((d) => { setData(d); ref.current = (d.servers || []).filter((s) => !s.managed).map(cloneServer); })
      .catch((ex) => setErr(ex.message));
  }, []);

  function markDirty() {
    registerDirty("mcp", { label: "MCP servers", save: async () => {
      const payload = ref.current.map((s) => ({ name: (s.name || "").trim(), command: (s.command || "").trim(),
        args: (s.argsText || "").split("\n").map((x) => x.trim()).filter(Boolean),
        env: parseEnv(s.envText || ""), enabled: s.enabled !== false, trust: s.trust || "owner" }));
      await api("PUT", "/api/mcp/servers", { servers: payload });
    } });
  }

  if (err) return <div><div class="page-head"><h1>MCP Servers</h1></div><p class="field-err">{err}</p></div>;
  if (!data) return <div><div class="page-head"><h1>MCP Servers</h1></div><p class="hint"><Spinner size={13} /> Loading…</p></div>;
  const managed = (data.servers || []).filter((s) => s.managed);
  const direct = ref.current || [];
  return (
    <div>
      <div class="page-head"><h1>MCP Servers</h1><p class="sub">Model Context Protocol servers expose external tools to the bot. Plugin-provided servers are managed by their plugin; you can also add your own. Changes apply on the next bot restart.</p></div>
      {!data.botRunning && <p class="hint" style="margin-bottom:12px">Live status/tools appear once the bot has started with these settings.</p>}

      <div class="seg"><h3>From plugins (managed)</h3></div>
      {!managed.length && <p class="empty">No plugin is running an MCP server. Enable one under Plugins.</p>}
      <div class="rows">{managed.map((s) => <McpManaged s={s} />)}</div>

      <div class="seg"><h3>Your servers</h3></div>
      <div class="rows">
        {direct.map((s, i) => <McpEditor s={s} onChange={markDirty} onRemove={() => { direct.splice(i, 1); rerender(); markDirty(); }} />)}
        {!direct.length && <p class="empty">No custom MCP servers yet.</p>}
      </div>
      <div class="row" style="margin-top:12px">
        <Btn variant="ghost" icon="plus" onClick={() => { direct.push({ name: "", command: "", argsText: "", envText: "", enabled: true, trust: "owner" }); rerender(); }}>Add MCP server</Btn>
      </div>
    </div>
  );
}
function cloneServer(s) { return { name: s.name, command: s.command || "", argsText: (s.args || []).join("\n"), envText: Object.entries(s.env || {}).map(([k, v]) => k + "=" + v).join("\n"), enabled: s.enabled !== false, trust: s.trust || "owner", status: s.status, tools: s.tools }; }
function parseEnv(text) { const out = {}; for (const line of text.split("\n")) { const t = line.trim(); if (!t) continue; const eq = t.indexOf("="); if (eq < 1) continue; out[t.slice(0, eq).trim()] = t.slice(eq + 1).trim(); } return out; }

function McpManaged({ s }) {
  return <Card class="card-pad">
    <div class="row"><strong>{s.label || s.name}</strong><StatusBadge status={s.status} error={s.error} /><span class="spacer" /><span class="hint">managed by the {s.plugin} plugin</span></div>
    {s.error && <p class="field-err">{s.error}</p>}
    <ToolsList s={s} />
  </Card>;
}
function McpEditor({ s, onChange, onRemove }) {
  const [, force] = useState(0); const upd = (k, v) => { s[k] = v; force((n) => n + 1); onChange(); };
  return <Card class="card-pad">
    <div class="row"><TextInput class="grow" placeholder="name (letters/digits/-/_)" value={s.name} onInput={(v) => upd("name", v)} /><StatusBadge status={s.status || "new"} /><IconBtn name="trash" label="Remove server" onClick={onRemove} /></div>
    <Field label="Command" hint="The executable to launch (stdio MCP server)."><TextInput value={s.command} onInput={(v) => upd("command", v)} placeholder="command, e.g. npx or node" /></Field>
    <Field label="Arguments" hint="One per line."><Textarea code value={s.argsText} style="min-height:70px" onInput={(v) => upd("argsText", v)} placeholder={"one argument per line\ne.g. -y\n@modelcontextprotocol/server-filesystem"} /></Field>
    <Field label="Environment" hint="KEY=value per line. Reference a secret without storing it here: KEY=${MY_SECRET}."><Textarea code value={s.envText} style="min-height:60px" onInput={(v) => upd("envText", v)} placeholder={"KEY=value, one per line\nuse KEY=${SECRET_NAME} to pull from secrets.env"} /></Field>
    <div class="row"><Switch checked={s.enabled !== false} onChange={(v) => upd("enabled", v)} label="enabled" /><Select value={s.trust || "owner"} options={[["owner", "trust: owner"], ["elevated", "trust: elevated"], ["light", "trust: light"]]} onInput={(v) => upd("trust", v)} /></div>
    <ToolsList s={s} />
  </Card>;
}
function ToolsList({ s }) {
  if (!s.tools || !s.tools.length) return s.status === "connected" ? <p class="hint tools-wrap">(no tools)</p> : <p class="hint tools-wrap">tools listed once running</p>;
  return <div class="tools-wrap">{s.tools.map((t) => <span class="tool-pill" title={t.description || ""}>{t.registeredName || t.name}</span>)}</div>;
}
