// Schema-driven form fields + list editors + token check-result. Settings fields
// mutate S.config.value in place and mark the unified "settings" scope dirty.
import { useState, useEffect } from "preact/hooks";
import { api } from "./api.js";
import { S, buffers, getPath, setPath, toast } from "./store.js";
import { markSettingsDirty } from "./actions.js";
import { Field, TextInput, NumberInput, Select, Switch, Textarea, Btn, IconBtn, Icon, Badge, Chip, Spinner } from "./ui.jsx";

// ---- shared secret input (reveal-on-click for stored values) ----
export function SecretInput({ present, revealKey, placeholder, onInput }) {
  const [shown, setShown] = useState(false);
  const [revealed, setRevealed] = useState(null);
  async function toggle() {
    if (shown) { setShown(false); return; }
    try { const r = await api("POST", "/api/secrets/reveal", { key: revealKey }); setRevealed(r.value); setShown(true); }
    catch (ex) { toast(ex.message, "bad"); }
  }
  return (
    <div class="input-wrap">
      {shown && revealed != null
        ? <input class="input mono" type="text" value={revealed} readOnly />
        : <input class="input" type="password" placeholder={placeholder || (present ? "•••••• (leave blank to keep)" : "not set")}
            onInput={(e) => onInput(e.target.value)} />}
      {present && <IconBtn name={shown ? "eyeoff" : "eye"} label="Show stored value" onClick={toggle} />}
      <Badge kind={present ? "set" : "off"}>{present ? "set" : "not set"}</Badge>
    </div>
  );
}

// ---- persona markdown (lazy-loaded) ----
function PersonaField({ f }) {
  const [val, setVal] = useState(buffers.personaEdits[f.persona] ?? buffers.personaCache[f.persona] ?? null);
  useEffect(() => {
    if (buffers.personaCache[f.persona] === undefined) {
      api("GET", "/api/persona/" + f.persona).then((r) => {
        buffers.personaCache[f.persona] = r.content || "";
        if (buffers.personaEdits[f.persona] === undefined) setVal(r.content || "");
      }).catch(() => setVal(""));
    }
  }, []);
  return (
    <Field label={f.label} hint={f.help}>
      <Textarea code value={val ?? ""} style="min-height:220px"
        onInput={(v) => { setVal(v); buffers.personaEdits[f.persona] = v; markSettingsDirty(); }} />
    </Field>
  );
}

function JsonField({ path, value }) {
  const [text, setText] = useState(JSON.stringify(value == null ? {} : value, null, 2));
  const [bad, setBad] = useState(false);
  return (
    <Textarea code value={text} class={bad ? "bad" : ""}
      onInput={(v) => { setText(v); try { setPath(S.config.value, path, JSON.parse(v)); setBad(false); markSettingsDirty(); } catch { setBad(true); } }} />
  );
}

// ---- main dispatcher ----
export function SchemaField({ f }) {
  if (f.secret) {
    const present = !!S.secrets.value[f.secret];
    return <Field label={f.label} hint={f.help}>
      <SecretInput present={present} revealKey={f.secret} onInput={(v) => { buffers.secretEdits[f.secret] = v; markSettingsDirty(); }} />
    </Field>;
  }
  if (f.persona) return <PersonaField f={f} />;
  const cfg = S.config.value;
  const val = getPath(cfg, f.path);
  const set = (v) => { setPath(cfg, f.path, v); markSettingsDirty(); };
  switch (f.type) {
    case "boolean": return <Field label={f.label} hint={f.help}><Switch checked={!!val} onChange={set} label={val ? "on" : "off"} /></Field>;
    case "number": return <Field label={f.label} hint={f.help}><NumberInput value={val} onInput={set} /></Field>;
    case "select": {
      // options may be plain strings or [value, label] pairs; the effective value is the
      // first element of a pair. Normalize the null-default so pair options don't fall back
      // to the whole [value,label] array.
      const firstVal = Array.isArray(f.options[0]) ? f.options[0][0] : f.options[0];
      return <Field label={f.label} hint={f.help}><Select value={val == null ? firstVal : String(val)} options={f.options} onInput={set} /></Field>;
    }
    case "binds": return <Field label={f.label} hint={f.help}><BindsEditor path={f.path} value={val} /></Field>;
    case "stringlist": return <Field label={f.label} hint={f.help}><StringListEditor path={f.path} value={val} /></Field>;
    case "peoplemap": return <Field label={f.label} hint={f.help}><PeopleEditor path={f.path} value={val} /></Field>;
    case "greetings": return <Field label={f.label} hint={f.help}><GreetingsEditor path={f.path} value={val} /></Field>;
    case "channels": return <Field label={f.label} hint={f.help}><ChannelsEditor path={f.path} value={val} /></Field>;
    case "json": return <Field label={f.label} hint={f.help}><JsonField path={f.path} value={val} /></Field>;
    case "llm": return <Field label={f.label} hint={f.help}><LlmEditor path={f.path} value={val} /></Field>;
    default: return <Field label={f.label} hint={f.help} required={f.required}><TextInput value={val == null ? "" : String(val)} onInput={set} /></Field>;
  }
}

// is this a scalar field (fits the two-column grid)?
export function isScalar(f) {
  return !["binds", "stringlist", "peoplemap", "greetings", "channels", "json", "llm"].includes(f.type) && !f.persona;
}

// ---- LLM request headers / query / billing (Claude tab) ----
// LLM_DEFAULTS mirrors src/ai/llm-defaults.js — keep in sync. x-claude-code-session-id
// is added dynamically by the bot, so it's not shown or editable here.
const LLM_DEFAULTS = {
  headers: {
    "anthropic-dangerous-direct-browser-access": "true",
    "anthropic-beta": "claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,web-search-2025-03-05",
    "x-app": "cli",
    "user-agent": "claude-cli/2.1.159 (external, sdk-cli)",
  },
  query: { beta: "true" },
  billingHeader: "cc_version=2.1.159.286; cc_entrypoint=sdk-cli; cch=e2159;",
};
const kvRows = (obj) => Object.entries(obj || {}).map(([k, v]) => ({ k, v: String(v) }));
const rowsToObj = (rows) => { const o = {}; for (const r of rows) { const k = (r.k || "").trim(); if (k) o[k] = r.v; } return o; };

// Module-level so it isn't remounted every render (which would drop input focus).
function KvTable({ rows, upd, keyPlaceholder }) {
  return (
    <div class="rows">
      {rows.map((r, i) => (
        <div class="erow">
          <TextInput class="grow" placeholder={keyPlaceholder} value={r.k} onInput={(val) => { const n = rows.map((x) => ({ ...x })); n[i].k = val; upd(n); }} />
          <TextInput class="grow" placeholder="value" value={r.v} onInput={(val) => { const n = rows.map((x) => ({ ...x })); n[i].v = val; upd(n); }} />
          <IconBtn name="trash" label="Remove" onClick={() => upd(rows.filter((_, j) => j !== i))} />
        </div>
      ))}
      <div><Btn variant="ghost" size="sm" icon="plus" onClick={() => upd([...rows, { k: "", v: "" }])}>Add</Btn></div>
    </div>
  );
}

function LlmEditor({ path, value }) {
  const v = value || {};
  const seededH = (v.headers && Object.keys(v.headers).length) ? v.headers : LLM_DEFAULTS.headers;
  const seededQ = (v.query && Object.keys(v.query).length) ? v.query : LLM_DEFAULTS.query;
  const [headers, setHeaders] = useState(() => kvRows(seededH));
  const [query, setQuery] = useState(() => kvRows(seededQ));
  const [billing, setBilling] = useState(v.billingHeader || LLM_DEFAULTS.billingHeader);
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState("");

  function commit(h, q, b) { setPath(S.config.value, path, { headers: rowsToObj(h), query: rowsToObj(q), billingHeader: b }); markSettingsDirty(); }
  const updH = (rows) => { setHeaders(rows); commit(rows, query, billing); };
  const updQ = (rows) => { setQuery(rows); commit(headers, rows, billing); };
  const updB = (b) => { setBilling(b); commit(headers, query, b); };

  function restore() {
    const h = kvRows(LLM_DEFAULTS.headers), q = kvRows(LLM_DEFAULTS.query);
    setHeaders(h); setQuery(q); setBilling(LLM_DEFAULTS.billingHeader);
    commit(h, q, LLM_DEFAULTS.billingHeader); toast("Restored default headers");
  }
  function copyAll() {
    const text = headers.filter((r) => (r.k || "").trim()).map((r) => r.k + ": " + r.v).join("\n");
    navigator.clipboard.writeText(text).then(() => toast("Copied headers")).catch(() => toast("Copy failed", "bad"));
  }
  function doImport() {
    const rows = [];
    for (const line of importText.split("\n")) {
      const t = line.trim(); if (!t) continue;
      const i = t.indexOf(":"); if (i < 1) continue;
      rows.push({ k: t.slice(0, i).trim(), v: t.slice(i + 1).trim() });
    }
    if (!rows.length) { toast("No 'Key: Value' lines found", "bad"); return; }
    setHeaders(rows); commit(rows, query, billing); setImportOpen(false); setImportText("");
    toast("Imported " + rows.length + " headers");
  }

  return (
    <div>
      <div class="row" style="margin-bottom:8px">
        <Btn variant="secondary" size="sm" onClick={copyAll}>Copy all</Btn>
        <Btn variant="secondary" size="sm" onClick={() => setImportOpen((o) => !o)}>Import</Btn>
        <Btn variant="ghost" size="sm" onClick={restore}>Restore defaults</Btn>
      </div>
      {importOpen && (
        <div style="margin-bottom:10px">
          <Textarea code value={importText} placeholder={"Paste headers, one per line:\nanthropic-beta: ...\nx-app: cli"} style="min-height:90px" onInput={setImportText} />
          <div class="row" style="margin-top:6px"><Btn variant="primary" size="sm" onClick={doImport}>Replace headers with pasted list</Btn></div>
        </div>
      )}
      <div class="group-head">Headers</div>
      <KvTable rows={headers} upd={updH} keyPlaceholder="header name" />
      <div class="group-head" style="margin-top:12px">Query params</div>
      <KvTable rows={query} upd={updQ} keyPlaceholder="param name" />
      <div class="group-head" style="margin-top:12px">Billing header (OAuth mode)</div>
      <TextInput value={billing} onInput={updB} placeholder="cc_version=...; cc_entrypoint=sdk-cli; ..." />
    </div>
  );
}

// ---- string list ----
function StringListEditor({ path, value }) {
  const [list, setList] = useState(() => (Array.isArray(value) ? value.slice() : []));
  function commit(next) { setList(next); setPath(S.config.value, path, next.filter((x) => x !== "")); markSettingsDirty(); }
  return (
    <div class="rows">
      {list.map((item, i) => (
        <div class="erow">
          <TextInput class="grow" value={item} onInput={(v) => { const n = list.slice(); n[i] = v; commit(n); }} />
          <IconBtn name="trash" label="Remove" onClick={() => commit(list.filter((_, j) => j !== i))} />
        </div>
      ))}
      <div><Btn variant="ghost" size="sm" icon="plus" onClick={() => setList([...list, ""])}>Add</Btn></div>
    </div>
  );
}

// ---- binds (listen addresses) ----
function BindsEditor({ path, value }) {
  const init = Array.isArray(value) ? value.slice() : (typeof value === "string" && value ? [value] : []);
  const [rows, setRows] = useState(init.length ? init : ["0.0.0.0"]);
  const [avail, setAvail] = useState(null);
  const [manual, setManual] = useState("");
  useEffect(() => { api("GET", "/api/netinfo").then((r) => setAvail(r.available || [])).catch(() => setAvail([])); }, []);
  function commit(next) { const v = next.length ? next : ["0.0.0.0"]; setRows(v); setPath(S.config.value, path, v.slice()); markSettingsDirty(); }
  const choices = (avail || []).filter((s) => !rows.includes(s.address));
  return (
    <div>
      <div class="add-suggest">
        {rows.map((a, i) => <Chip onRemove={() => commit(rows.filter((_, j) => j !== i))}>{a}</Chip>)}
      </div>
      {rows.includes("0.0.0.0") && <p class="hint">0.0.0.0 already covers all interfaces — other addresses are ignored while it's listed.</p>}
      <div class="add-suggest">
        {avail == null ? <span class="hint">loading addresses…</span> : <span class="hint">Click to add:</span>}
        {choices.map((s) => <Btn variant="ghost" size="sm" onClick={() => commit([...rows, s.address])}>+ {s.address} <span class="faint">{s.label}</span></Btn>)}
      </div>
      <div class="erow">
        <TextInput class="grow" placeholder="add an address manually" value={manual} onInput={setManual} />
        <Btn variant="ghost" size="sm" onClick={() => { if (manual.trim() && !rows.includes(manual.trim())) { commit([...rows, manual.trim()]); setManual(""); } }}>Add</Btn>
      </div>
    </div>
  );
}

// ---- people / trust map ----
function PeopleEditor({ path, value }) {
  const [rows, setRows] = useState(() => Object.entries(value && typeof value === "object" ? value : {}).map(([id, v]) => ({ id, name: v.name || "", trust: v.trust || "light" })));
  function commit(next) { setRows(next); const out = {}; for (const r of next) if (r.id.trim()) out[r.id.trim()] = { name: r.name, trust: r.trust }; setPath(S.config.value, path, out); markSettingsDirty(); }
  const upd = (i, k, v) => { const n = rows.map((r) => ({ ...r })); n[i][k] = v; commit(n); };
  return (
    <div class="rows">
      {rows.map((r, i) => (
        <div class="erow">
          <TextInput class="grow" placeholder="user ID" value={r.id} onInput={(v) => upd(i, "id", v)} />
          <TextInput class="grow" placeholder="name" value={r.name} onInput={(v) => upd(i, "name", v)} />
          <Select value={r.trust} options={["owner", "elevated", "light"]} onInput={(v) => upd(i, "trust", v)} />
          <IconBtn name="trash" label="Remove" onClick={() => commit(rows.filter((_, j) => j !== i))} />
        </div>
      ))}
      <div><Btn variant="ghost" size="sm" icon="plus" onClick={() => setRows([...rows, { id: "", name: "", trust: "light" }])}>Add person</Btn></div>
    </div>
  );
}

// ---- presence greetings ----
function GreetingsEditor({ path, value }) {
  const [rows, setRows] = useState(() => (Array.isArray(value) ? value.map((g) => ({ ...g })) : []));
  function commit(next) { setRows(next); setPath(S.config.value, path, next.filter((r) => r.userId)); markSettingsDirty(); }
  const upd = (i, k, v) => { const n = rows.map((r) => ({ ...r })); n[i][k] = v; commit(n); };
  return (
    <div class="rows">
      {rows.map((r, i) => (
        <div class="erow">
          <TextInput class="grow" placeholder="user ID" value={r.userId || ""} onInput={(v) => upd(i, "userId", v)} />
          <TextInput class="grow" placeholder="online or playing:roblox" value={r.trigger || ""} onInput={(v) => upd(i, "trigger", v)} />
          <TextInput class="grow" placeholder="Hi <@{id}>!" value={r.message || ""} onInput={(v) => upd(i, "message", v)} />
          <IconBtn name="trash" label="Remove" onClick={() => commit(rows.filter((_, j) => j !== i))} />
        </div>
      ))}
      <div><Btn variant="ghost" size="sm" icon="plus" onClick={() => setRows([...rows, { userId: "", trigger: "online", message: "" }])}>Add greeting</Btn></div>
    </div>
  );
}

// ---- channels (with server→channel picker, grouped) ----
const MODE_OPTS = [["everything", "everything (reply if useful)"], ["name", "name, @, or reply"], ["mention", "@ or reply only"], ["off", "off"]];
const normMode = (m) => (m === "all" ? "everything" : m === "addressed" ? "name" : (["everything", "name", "mention", "off"].includes(m) ? m : "name"));
function ChannelsEditor({ path, value }) {
  const [rows, setRows] = useState(() => (Array.isArray(value) ? value.map((c) => ({ ...c })) : []));
  const [guilds, setGuilds] = useState(S.discordChannels.value);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [gi, setGi] = useState("");
  const [ci, setCi] = useState("");
  const [botId, setBotId] = useState(null);

  function load(force) {
    if (loading) return;
    if (guilds && !force) return;
    setLoading(true); setError(null);
    api("GET", "/api/discord/channels").then((r) => { S.discordChannels.value = r.guilds || []; setGuilds(r.guilds || []); setBotId(r.botId || null); setLoading(false); })
      .catch((ex) => { setError(ex.message); setLoading(false); });
  }
  useEffect(() => { if (!guilds) load(false); }, []);

  function resolve(id) { if (!guilds) return null; for (const g of guilds) for (const ch of g.channels) if (ch.id === id) return { name: ch.name, guild: g.guildName }; return null; }
  function commit(next) { setRows(next); setPath(S.config.value, path, next.filter((r) => r.id).map((r) => ({ id: r.id, name: r.name, guild: r.guild, mode: normMode(r.mode), respondToOthers: !!r.respondToOthers, respondToBots: !!r.respondToBots }))); markSettingsDirty(); }
  const upd = (i, k, v) => { const n = rows.map((r) => ({ ...r })); n[i][k] = v; commit(n); };

  // resolve names + group
  const resolved = rows.map((r) => { const g = resolve(r.id); return g ? { ...r, name: g.name, guild: g.guild } : r; });
  const groups = new Map();
  resolved.forEach((r, idx) => { const k = r.guild || "Other / not loaded"; if (!groups.has(k)) groups.set(k, []); groups.get(k).push({ r, idx }); });
  const selGuild = guilds && gi !== "" ? guilds[Number(gi)] : null;
  const inviteUrl = (perms) => `https://discord.com/oauth2/authorize?client_id=${botId}&scope=bot&permissions=${perms}`;
  const InviteButtons = ({ small }) => !botId ? null : (
    <div class="row" style={small ? "" : "margin-top:10px"}>
      <a class={`btn btn-primary ${small ? "btn-sm" : ""}`} href={inviteUrl(8)} target="_blank" rel="noopener">Invite bot (Administrator)</a>
      <a class={`btn btn-ghost ${small ? "btn-sm" : ""}`} href={inviteUrl(117824)} target="_blank" rel="noopener">Invite (messaging only)</a>
    </div>
  );

  return (
    <div>
      {[...groups.entries()].map(([gname, items]) => (
        <div>
          <div class="group-head">{gname}</div>
          <div class="rows">
            {items.map(({ r, idx }) => (
              <div class="erow">
                <div class="grow"><strong>{r.name ? "#" + r.name : r.id}</strong> <span class="faint caption">({r.id})</span></div>
                <Select value={normMode(r.mode)} options={MODE_OPTS} onInput={(v) => upd(idx, "mode", v)} />
                <Switch size="sm" checked={!!r.respondToOthers} onChange={(v) => upd(idx, "respondToOthers", v)} label="answer others" />
                <Switch size="sm" checked={!!r.respondToBots} onChange={(v) => upd(idx, "respondToBots", v)} label="answer bots" />
                <IconBtn name="trash" label="Remove" onClick={() => commit(rows.filter((_, j) => j !== idx))} />
              </div>
            ))}
          </div>
        </div>
      ))}
      {rows.length === 0 && <p class="empty">No channels yet — add one below.</p>}
      {loading && <p class="hint"><Spinner size={13} /> Loading your servers…</p>}
      {error && <p class="field-err">Couldn't load channels: {error}</p>}

      {guilds && guilds.length ? (
        <div>
          <div class="picker">
            <Select value={gi} options={[["", "— server —"], ...guilds.map((g, i) => [String(i), g.guildName])]} onInput={(v) => { setGi(v); setCi(""); }} />
            <Select value={ci} options={[["", "— channel —"], ...(selGuild ? selGuild.channels.filter((ch) => !rows.some((r) => r.id === ch.id)).map((ch) => [ch.id, "#" + ch.name]) : [])]} onInput={setCi} />
            <Btn variant="secondary" size="sm" icon="plus" onClick={() => { if (selGuild && ci && !rows.some((r) => r.id === ci)) { const ch = selGuild.channels.find((c) => c.id === ci); commit([...rows, { id: ci, name: ch ? ch.name : "", guild: selGuild.guildName, mode: "addressed", respondToBots: false }]); setCi(""); } }}>Add channel</Btn>
            <Btn variant="ghost" size="sm" onClick={() => load(true)}>↻ Refresh</Btn>
          </div>
          {botId && <p class="hint" style="margin-top:10px">Add the bot to another server: <a href={inviteUrl(8)} target="_blank" rel="noopener">invite (Administrator)</a> · <a href={inviteUrl(117824)} target="_blank" rel="noopener">invite (messaging only)</a></p>}
        </div>
      ) : guilds && !guilds.length && !loading ? (
        <div class="card card-pad" style="margin-top:12px">
          <p style="font-weight:600;margin-bottom:4px">The bot isn't in any Discord server yet.</p>
          <p class="hint">Invite it with a button below (opens Discord — pick the server and authorize), then hit Refresh. <b>Administrator</b> grants full access; <b>messaging only</b> is the minimal set to read/send in channels. Also enable all three <b>Privileged Gateway Intents</b> (Presence, Server Members, Message Content) under your app → Bot in the <a href="https://discord.com/developers/applications" target="_blank" rel="noopener">Developer Portal ↗</a> — the bot can't connect without them.</p>
          <InviteButtons />
          <div class="picker"><Btn variant="secondary" size="sm" onClick={() => load(true)}>↻ Refresh</Btn></div>
        </div>
      ) : !loading && (
        <div class="picker"><Btn variant="secondary" size="sm" onClick={() => load(true)}>{error ? "Retry" : "Load servers from Discord"}</Btn></div>
      )}
    </div>
  );
}

// ---- token check-result ----
export function CheckResult({ res }) {
  if (!res) return null;
  const chips = (label, items, brand) => items && items.length ? (
    <div class="cr-block"><div class="cr-lbl">{label}</div><div class="cr-chips">{items.map((it) => <span class={`chip ${brand ? "brand" : ""}`}>{it}</span>)}</div></div>
  ) : null;
  const entities = (label, items, total) => items && items.length ? (
    <div class="cr-block">
      <div class="cr-lbl">{label} ({total != null ? total : items.length})</div>
      <div class="cr-entities">{items.map((it) => <div class="cr-entity"><span class="e-name">{it.name || it.id || "?"}</span>{it.id && it.name && <span class="e-id mono">{it.id}</span>}</div>)}</div>
      {total != null && total > items.length && <p class="hint">+{total - items.length} more not shown</p>}
    </div>
  ) : null;
  return (
    <div class={`check-result ${res.ok ? "" : "bad"}`}>
      <div class="cr-head">
        <span class={`status ${res.ok ? "ok" : "err"}`}><span class="dot" /></span>
        <span>{res.ok ? "Connected" + (res.identity ? " — " + res.identity : "") : "Failed — " + (res.error || "invalid")}</span>
      </div>
      {res.ok && <>
        {res.status && <p class="hint">Status: {res.status}</p>}
        {chips("Permissions", res.permissions, true)}
        {(!res.permissions || !res.permissions.length) && res.permissionsNote && <p class="hint">{res.permissionsNote}</p>}
        {chips("Scopes", res.scopes)}
        {(!res.scopes || !res.scopes.length) && res.note && <p class="hint">{res.note}</p>}
        {entities("Accounts", res.accounts)}
        {entities("Domains", res.zones, res.zonesTotal)}
        {(res.details || []).map((d) => <p class="hint">{d.label}: {d.value}</p>)}
      </>}
    </div>
  );
}
