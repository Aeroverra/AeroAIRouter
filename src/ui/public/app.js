"use strict";

const state = {
  csrf: null,
  config: {},
  secrets: {},
  schema: [],
  advanced: false,
  active: null,
  dirty: false,
  secretEdits: {},
  personaCache: {},
  personaEdits: {},
  discordChannels: null,
};

// ---------- tiny helpers ----------
const $ = (sel, root = document) => root.querySelector(sel);
const el = (tag, props = {}, kids = []) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") n.className = v;
    else if (k === "text") n.textContent = v;
    else if (k.startsWith("on") && typeof v === "function") n.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined) n.setAttribute(k, v);
  }
  for (const c of [].concat(kids)) if (c) n.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  return n;
};
function tpl(id) { return document.importNode($("#" + id).content, true); }
function toast(msg, bad) {
  const t = el("div", { class: "toast" + (bad ? " bad" : ""), text: msg });
  document.body.appendChild(t);
  setTimeout(() => t.remove(), bad ? 5000 : 2500);
}
function getPath(obj, path) {
  return path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);
}
function setPath(obj, path, val) {
  const keys = path.split(".");
  let o = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (typeof o[keys[i]] !== "object" || o[keys[i]] === null) o[keys[i]] = {};
    o = o[keys[i]];
  }
  o[keys[keys.length - 1]] = val;
}

async function api(method, url, body) {
  const opts = { method, headers: {} };
  if (body !== undefined) { opts.headers["Content-Type"] = "application/json"; opts.body = JSON.stringify(body); }
  if (method !== "GET" && state.csrf) opts.headers["X-CSRF-Token"] = state.csrf;
  const r = await fetch(url, opts);
  let data = null;
  try { data = await r.json(); } catch {}
  if (!r.ok) throw new Error((data && data.error) || ("HTTP " + r.status));
  return data;
}

// ---------- boot / routing ----------
async function boot() {
  const status = await api("GET", "/api/status").catch(() => ({}));
  if (status.needsPassword || status.needsConfig) return renderSetup("first", status);
  if (!status.authed) return renderLogin();
  return openDash();
}

function mount(node) {
  const app = $("#app");
  app.innerHTML = "";
  app.appendChild(node);
}

// ---------- login ----------
function renderLogin() {
  const frag = tpl("tpl-login");
  const form = $("[data-form=login]", frag);
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const err = $("[data-err]", form);
    err.textContent = "";
    try {
      const res = await api("POST", "/api/login", { password: form.password.value });
      state.csrf = res.csrf;
      await openDash();
    } catch (ex) { err.textContent = ex.message; }
  });
  mount(frag);
}

// ---------- setup wizard (first-run + re-run) ----------
function renderSetup(mode, status) {
  const frag = tpl("tpl-setup");
  const form = $("[data-form=setup]", frag);
  const rerun = mode === "rerun";

  $("[data-setup-title]", form).textContent = rerun ? "Re-run setup" : "Welcome to AeroAIRouter";
  $("[data-setup-sub]", form).textContent = rerun
    ? "Adjust the essentials below. Secret fields are blank — leave blank to keep the current value."
    : "First-run setup. Fields marked * are required.";
  $("[data-setup-submit]", form).textContent = rerun ? "Save" : "Finish setup";

  // password step only on first-run when a password isn't set yet
  const pwBlock = $("[data-when=needsPassword]", form);
  if (rerun || (status && !status.needsPassword)) pwBlock.remove();

  if (rerun) {
    const cancel = $("[data-action=setup-cancel]", form);
    cancel.hidden = false;
    cancel.addEventListener("click", () => openDash());
    // prefill from current config
    const c = state.config;
    form.botName.value = getPath(c, "discord.wakeWord") || "";
    form.ownerId.value = getPath(c, "discord.ownerId") || "";
    form.guildId.value = getPath(c, "discord.guilds.home.id") || "";
    form.botChannel.value = getPath(c, "discord.guilds.home.channels.bot") || "";
    form.generalChannel.value = getPath(c, "discord.guilds.home.channels.general") || "";
    form.authMode.value = getPath(c, "ai.auth.mode") || "auto";
    form.model.value = getPath(c, "ai.models.complex") || "";
    form.emoji.value = getPath(c, "persona.emoji") || "";
    form.querySelectorAll("[data-secret-note]").forEach((n) => (n.textContent = "(leave blank to keep current)"));
  }

  // Discord token test
  $("[data-action=test-token]", form).addEventListener("click", async () => {
    const out = $("[data-token-check]", form);
    const token = form.DISCORD_TOKEN.value.trim();
    if (!token) { out.textContent = "Enter a token first"; out.className = "check bad"; return; }
    out.textContent = "Checking…"; out.className = "check";
    try {
      const r = await api("POST", "/api/check-discord", { token });
      if (r.ok) { out.textContent = "✓ Valid — logged in as " + r.username; out.className = "check ok"; }
      else { out.textContent = "✗ " + r.error; out.className = "check bad"; }
    } catch (ex) { out.textContent = "✗ " + ex.message; out.className = "check bad"; }
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const err = $("[data-err]", form);
    err.textContent = "";
    try {
      if (!rerun && pwBlock.parentNode) {
        if (form.password.value !== form.password2.value) throw new Error("Passwords do not match");
      }
      // map wizard fields onto a config patch
      const patch = {};
      const set = (p, v) => { if (v !== "" && v !== undefined) setPath(patch, p, v); };
      set("discord.wakeWord", form.botName.value.trim());
      set("discord.ownerId", form.ownerId.value.trim());
      set("discord.guilds.home.id", form.guildId.value.trim());
      set("discord.guilds.home.channels.bot", form.botChannel.value.trim());
      set("discord.guilds.home.channels.general", form.generalChannel.value.trim());
      set("ai.auth.mode", form.authMode.value);
      if (form.model.value.trim()) { set("ai.models.complex", form.model.value.trim()); set("ai.models.casual", form.model.value.trim()); }
      setPath(patch, "persona.emoji", form.emoji.value); // allow clearing
      // owner in people map
      const owner = form.ownerId.value.trim();
      if (owner) setPath(patch, "discord.people." + owner, { name: form.botName.value.trim() ? "Owner" : "Owner", trust: "owner" });
      // channels from bot/general
      const chans = [];
      if (form.botChannel.value.trim()) chans.push({ id: form.botChannel.value.trim(), mode: "all", respondToBots: false });
      if (form.generalChannel.value.trim()) chans.push({ id: form.generalChannel.value.trim(), mode: "addressed", respondToBots: false });
      if (chans.length) setPath(patch, "discord.channels", chans);

      const secrets = {};
      for (const k of ["DISCORD_TOKEN", "ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "BRAVE_API_KEY"]) {
        if (form[k] && form[k].value.trim()) secrets[k] = form[k].value.trim();
      }

      if (rerun) {
        const merged = deepMerge(structuredClone(state.config), patch);
        await api("PUT", "/api/config", { config: merged });
        if (Object.keys(secrets).length) await api("PUT", "/api/secrets", { secrets });
        toast("Setup saved");
        await openDash();
      } else {
        if (!form.DISCORD_TOKEN.value.trim()) throw new Error("Discord token is required");
        if (!owner) throw new Error("Owner user ID is required");
        const res = await api("POST", "/api/setup", {
          setupCode: form.setupCode ? form.setupCode.value.trim() : undefined,
          password: form.password ? form.password.value : undefined,
          config: patch,
          secrets,
        });
        state.csrf = res.csrf;
        toast("Setup complete");
        await openDash();
      }
    } catch (ex) { err.textContent = ex.message; }
  });

  mount(frag);
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

// ---------- dashboard ----------
async function openDash() {
  const data = await api("GET", "/api/config");
  state.config = data.config || {};
  state.secrets = data.secrets || {};
  state.schema = data.schema || [];
  state.secretEdits = {};
  state.personaEdits = {};
  state.dirty = false;
  if (!state.csrf) { const c = await api("GET", "/api/csrf"); state.csrf = c.csrf; }
  state.active = state.active || (state.schema[0] && state.schema[0].id);
  renderDash();
  refreshBotStatus();
}

function renderDash() {
  const frag = tpl("tpl-dash");
  const root = frag.firstElementChild ? frag : frag;
  // advanced toggle
  const adv = $("[data-advanced]", frag);
  adv.checked = state.advanced;
  adv.addEventListener("change", () => { state.advanced = adv.checked; renderContent(); });
  // actions
  $("[data-action=logout]", frag).addEventListener("click", async () => { await api("POST", "/api/logout"); location.reload(); });
  $("[data-action=restart]", frag).addEventListener("click", restartBot);
  $("[data-action=password]", frag).addEventListener("click", changePassword);
  $("[data-action=save]", frag).addEventListener("click", saveAll);

  // sidebar
  const nav = $("[data-nav]", frag);
  for (const sec of state.schema) {
    const b = el("button", { text: sec.title, class: sec.id === state.active ? "active" : "" });
    b.addEventListener("click", () => { if (confirmLeave()) { state.active = sec.id; renderDash(); } });
    nav.appendChild(b);
  }
  // extra virtual sections
  for (const extra of [{ id: "__access", title: "Access & URLs" }, { id: "__raw", title: "Raw JSON" }]) {
    const b = el("button", { text: extra.title, class: extra.id === state.active ? "active" : "" });
    b.addEventListener("click", () => { if (confirmLeave()) { state.active = extra.id; renderDash(); } });
    nav.appendChild(b);
  }

  mount(frag);
  renderContent();
  updateSavebar();
}

function confirmLeave() {
  if (!state.dirty) return true;
  return confirm("You have unsaved changes. Discard them?") ? (revertEdits(), true) : false;
}
function revertEdits() { /* edits live in state.config; reload from server to revert */ state.dirty = false; }

function renderContent() {
  const c = $("[data-content]");
  if (!c) return;
  c.innerHTML = "";
  if (state.active === "__access") return renderAccess(c);
  if (state.active === "__raw") return renderRaw(c);
  const sec = state.schema.find((s) => s.id === state.active);
  if (!sec) return;
  c.appendChild(el("h2", { text: sec.title }));
  if (sec.help) c.appendChild(el("p", { class: "section-help", text: sec.help }));
  for (const f of sec.fields) {
    if (f.advanced && !state.advanced) continue;
    c.appendChild(renderField(f));
  }
}

function markDirty() { state.dirty = true; updateSavebar(); }
function updateSavebar() {
  const bar = $("[data-savebar]");
  if (bar) bar.hidden = !state.dirty;
}

// ---------- field renderers ----------
function renderField(f) {
  const wrap = el("div", { class: "field" });
  wrap.appendChild(el("label", { text: f.label }));
  if (f.help) wrap.appendChild(el("span", { class: "hint", text: f.help }));

  if (f.secret) return renderSecret(wrap, f);
  if (f.persona) return renderPersona(wrap, f);
  const val = getPath(state.config, f.path);

  switch (f.type) {
    case "boolean": {
      const cb = el("input", { type: "checkbox" });
      cb.checked = !!val; cb.style.width = "auto";
      cb.addEventListener("change", () => { setPath(state.config, f.path, cb.checked); markDirty(); });
      const l = el("label", { class: "switch" }, [cb, " enabled"]);
      wrap.appendChild(l);
      break;
    }
    case "number": {
      const i = el("input", { type: "text", value: val == null ? "" : String(val) });
      i.addEventListener("input", () => { const n = Number(i.value); setPath(state.config, f.path, i.value === "" ? undefined : (isNaN(n) ? i.value : n)); markDirty(); });
      wrap.appendChild(i);
      break;
    }
    case "select": {
      const s = el("select");
      for (const o of f.options) s.appendChild(el("option", { value: o, text: o }));
      s.value = val == null ? f.options[0] : val;
      s.addEventListener("change", () => { setPath(state.config, f.path, s.value); markDirty(); });
      wrap.appendChild(s);
      break;
    }
    case "stringlist": return renderStringList(wrap, f, val);
    case "peoplemap": return renderPeople(wrap, f, val);
    case "greetings": return renderGreetings(wrap, f, val);
    case "channels": return renderChannels(wrap, f, val);
    case "json": {
      const ta = el("textarea");
      ta.value = JSON.stringify(val == null ? {} : val, null, 2);
      ta.addEventListener("input", () => {
        try { setPath(state.config, f.path, JSON.parse(ta.value)); ta.classList.remove("bad"); markDirty(); }
        catch { ta.classList.add("bad"); }
      });
      wrap.appendChild(ta);
      break;
    }
    default: { // string
      const i = el("input", { type: "text", value: val == null ? "" : String(val) });
      i.addEventListener("input", () => { setPath(state.config, f.path, i.value); markDirty(); });
      wrap.appendChild(i);
    }
  }
  return wrap;
}

function renderSecret(wrap, f) {
  const isSet = !!state.secrets[f.secret];
  const badge = el("span", { class: "badge" + (isSet ? " set" : ""), text: isSet ? "set" : "not set" });
  const i = el("input", { type: "password", placeholder: isSet ? "•••••• (leave blank to keep)" : "not set" });
  i.addEventListener("input", () => { state.secretEdits[f.secret] = i.value; markDirty(); });
  const row = el("div", { class: "row" }, [i, badge]);
  wrap.appendChild(row);
  return wrap;
}

function renderPersona(wrap, f) {
  const ta = el("textarea", { placeholder: "loading…" });
  ta.value = state.personaEdits[f.persona] !== undefined ? state.personaEdits[f.persona]
    : (state.personaCache[f.persona] !== undefined ? state.personaCache[f.persona] : "");
  if (state.personaCache[f.persona] === undefined) {
    api("GET", "/api/persona/" + f.persona).then((r) => {
      state.personaCache[f.persona] = r.content || "";
      if (state.personaEdits[f.persona] === undefined) ta.value = r.content || "";
    }).catch(() => {});
  }
  ta.addEventListener("input", () => { state.personaEdits[f.persona] = ta.value; markDirty(); });
  wrap.appendChild(ta);
  return wrap;
}

function renderStringList(wrap, f, val) {
  const list = Array.isArray(val) ? val.slice() : [];
  const container = el("div");
  function commit() { setPath(state.config, f.path, list.filter((x) => x !== "")); markDirty(); }
  function draw() {
    container.innerHTML = "";
    list.forEach((item, idx) => {
      const inp = el("input", { type: "text", value: item });
      inp.addEventListener("input", () => { list[idx] = inp.value; commit(); });
      const rm = el("button", { class: "ghost", text: "✕" });
      rm.addEventListener("click", () => { list.splice(idx, 1); draw(); commit(); });
      container.appendChild(el("div", { class: "list-row" }, [inp, rm]));
    });
    const add = el("button", { class: "ghost", text: "+ Add" });
    add.addEventListener("click", () => { list.push(""); draw(); });
    container.appendChild(add);
  }
  draw();
  wrap.appendChild(container);
  return wrap;
}

function renderPeople(wrap, f, val) {
  const map = val && typeof val === "object" ? Object.assign({}, val) : {};
  const rows = Object.entries(map).map(([id, v]) => ({ id, name: v.name || "", trust: v.trust || "light" }));
  const container = el("div");
  function commit() {
    const out = {};
    for (const r of rows) if (r.id.trim()) out[r.id.trim()] = { name: r.name, trust: r.trust };
    setPath(state.config, f.path, out); markDirty();
  }
  function draw() {
    container.innerHTML = "";
    rows.forEach((r, idx) => {
      const id = el("input", { type: "text", value: r.id, placeholder: "user ID" });
      id.addEventListener("input", () => { r.id = id.value; commit(); });
      const name = el("input", { type: "text", value: r.name, placeholder: "name" });
      name.addEventListener("input", () => { r.name = name.value; commit(); });
      const tr = el("select");
      ["owner", "elevated", "light"].forEach((t) => tr.appendChild(el("option", { value: t, text: t })));
      tr.value = r.trust;
      tr.addEventListener("change", () => { r.trust = tr.value; commit(); });
      const rm = el("button", { class: "ghost", text: "✕" });
      rm.addEventListener("click", () => { rows.splice(idx, 1); draw(); commit(); });
      container.appendChild(el("div", { class: "list-row" }, [id, name, tr, rm]));
    });
    const add = el("button", { class: "ghost", text: "+ Add person" });
    add.addEventListener("click", () => { rows.push({ id: "", name: "", trust: "light" }); draw(); });
    container.appendChild(add);
  }
  draw();
  wrap.appendChild(container);
  return wrap;
}

function renderGreetings(wrap, f, val) {
  const rows = Array.isArray(val) ? val.map((g) => Object.assign({}, g)) : [];
  const container = el("div");
  function commit() { setPath(state.config, f.path, rows.filter((r) => r.userId)); markDirty(); }
  function draw() {
    container.innerHTML = "";
    rows.forEach((r, idx) => {
      const uid = el("input", { type: "text", value: r.userId || "", placeholder: "user ID" });
      uid.addEventListener("input", () => { r.userId = uid.value; commit(); });
      const trig = el("input", { type: "text", value: r.trigger || "", placeholder: "online or playing:roblox" });
      trig.addEventListener("input", () => { r.trigger = trig.value; commit(); });
      const msg = el("input", { type: "text", value: r.message || "", placeholder: "Hi <@{id}>!" });
      msg.addEventListener("input", () => { r.message = msg.value; commit(); });
      const rm = el("button", { class: "ghost", text: "✕" });
      rm.addEventListener("click", () => { rows.splice(idx, 1); draw(); commit(); });
      container.appendChild(el("div", { class: "list-row" }, [uid, trig, msg, rm]));
    });
    const add = el("button", { class: "ghost", text: "+ Add greeting" });
    add.addEventListener("click", () => { rows.push({ userId: "", trigger: "online", message: "" }); draw(); });
    container.appendChild(add);
  }
  draw();
  wrap.appendChild(container);
  return wrap;
}

function renderChannels(wrap, f, val) {
  const rows = Array.isArray(val) ? val.map((c) => Object.assign({}, c)) : [];
  const container = el("div");
  function commit() { setPath(state.config, f.path, rows.filter((r) => r.id)); markDirty(); }
  function labelFor(id) {
    if (!state.discordChannels) return id;
    for (const g of state.discordChannels) for (const ch of g.channels) if (ch.id === id) return "#" + ch.name + " (" + g.guildName + ")";
    return id;
  }
  function draw() {
    container.innerHTML = "";
    rows.forEach((r, idx) => {
      const idLabel = el("input", { type: "text", value: r.id || "", placeholder: "channel ID" });
      idLabel.addEventListener("input", () => { r.id = idLabel.value; commit(); });
      const mode = el("select");
      [["all", "respond to all"], ["addressed", "only when addressed"], ["off", "off"]].forEach(([v, t]) => mode.appendChild(el("option", { value: v, text: t })));
      mode.value = r.mode || "addressed";
      mode.addEventListener("change", () => { r.mode = mode.value; commit(); });
      const botsCb = el("input", { type: "checkbox" }); botsCb.checked = !!r.respondToBots; botsCb.style.width = "auto";
      botsCb.addEventListener("change", () => { r.respondToBots = botsCb.checked; commit(); });
      const botsL = el("label", { class: "switch" }, [botsCb, " bots"]);
      const rm = el("button", { class: "ghost", text: "✕" });
      rm.addEventListener("click", () => { rows.splice(idx, 1); draw(); commit(); });
      const nameTag = el("span", { class: "hint", text: labelFor(r.id) });
      container.appendChild(el("div", { class: "list-row" }, [idLabel, mode, botsL, rm]));
      container.appendChild(el("div", { class: "hint", text: nameTag.textContent }));
    });
    // picker
    const picker = el("select");
    picker.appendChild(el("option", { value: "", text: "— pick a channel to add —" }));
    if (state.discordChannels) {
      for (const g of state.discordChannels) for (const ch of g.channels) {
        picker.appendChild(el("option", { value: ch.id, text: "#" + ch.name + " — " + g.guildName }));
      }
    }
    picker.addEventListener("change", () => {
      if (picker.value && !rows.some((r) => r.id === picker.value)) { rows.push({ id: picker.value, mode: "addressed", respondToBots: false }); draw(); commit(); }
    });
    const loadBtn = el("button", { class: "ghost", text: state.discordChannels ? "Reload channels" : "Load channels from Discord" });
    loadBtn.addEventListener("click", async () => {
      loadBtn.textContent = "Loading…";
      try { const r = await api("GET", "/api/discord/channels"); state.discordChannels = r.guilds || []; draw(); }
      catch (ex) { toast(ex.message, true); loadBtn.textContent = "Retry load"; }
    });
    const manual = el("button", { class: "ghost", text: "+ Add by ID" });
    manual.addEventListener("click", () => { rows.push({ id: "", mode: "addressed", respondToBots: false }); draw(); });
    container.appendChild(el("div", { class: "list-row" }, [picker]));
    container.appendChild(el("div", { class: "list-row" }, [loadBtn, manual]));
  }
  draw();
  wrap.appendChild(container);
  return wrap;
}

// ---------- virtual sections ----------
function renderAccess(c) {
  c.appendChild(el("h2", { text: "Access & URLs" }));
  c.appendChild(el("p", { class: "section-help", text: "The UI is reachable at these addresses (LAN + Tailscale)." }));
  const ul = el("ul", { class: "url-list" });
  c.appendChild(ul);
  api("GET", "/api/netinfo").then((r) => {
    for (const u of r.urls || []) {
      ul.appendChild(el("li", {}, [el("a", { href: u.url, target: "_blank", text: u.url }), el("span", { class: "badge", text: u.kind + (u.iface ? " · " + u.iface : "") })]));
    }
  }).catch((ex) => ul.appendChild(el("li", { text: ex.message })));
}

function renderRaw(c) {
  c.appendChild(el("h2", { text: "Raw config.json" }));
  c.appendChild(el("p", { class: "section-help", text: "Edit the full config object. Secrets are never stored here." }));
  const ta = el("textarea", { style: "min-height:420px" });
  ta.value = JSON.stringify(state.config, null, 2);
  const err = el("p", { class: "err" });
  ta.addEventListener("input", () => {
    try { const parsed = JSON.parse(ta.value); state.config = parsed; err.textContent = ""; markDirty(); }
    catch (ex) { err.textContent = ex.message; }
  });
  c.appendChild(ta);
  c.appendChild(err);
}

// ---------- save ----------
async function saveAll() {
  try {
    await api("PUT", "/api/config", { config: state.config });
    const secretUpdates = {};
    for (const [k, v] of Object.entries(state.secretEdits)) if (v && v.trim()) secretUpdates[k] = v.trim();
    if (Object.keys(secretUpdates).length) { const r = await api("PUT", "/api/secrets", { secrets: secretUpdates }); state.secrets = r.secrets; }
    for (const [name, content] of Object.entries(state.personaEdits)) await api("PUT", "/api/persona/" + name, { content });
    state.secretEdits = {}; state.personaEdits = {}; state.dirty = false;
    updateSavebar();
    toast("Saved. Restart the bot to apply.");
    renderContent();
  } catch (ex) { toast(ex.message, true); }
}

// ---------- bot control / misc ----------
async function refreshBotStatus() {
  const span = $("[data-bot-status]");
  if (!span) return;
  try {
    const r = await api("GET", "/api/bot/status");
    span.textContent = "bot: " + r.status;
    span.className = "bot-status " + r.status;
  } catch { span.textContent = "bot: ?"; }
}
async function restartBot() {
  if (!confirm("Restart the bot service now?")) return;
  try { await api("POST", "/api/bot/restart"); toast("Bot restarting…"); setTimeout(refreshBotStatus, 4000); }
  catch (ex) { toast(ex.message, true); }
}
async function changePassword() {
  const current = prompt("Current password:");
  if (current == null) return;
  const next = prompt("New password (min 6 chars):");
  if (!next) return;
  try { await api("PUT", "/api/password", { current, next }); toast("Password changed"); }
  catch (ex) { toast(ex.message, true); }
}

// re-run setup entry point from the dashboard
window.addEventListener("keydown", (e) => {});
document.addEventListener("click", (e) => {
  if (e.target && e.target.matches("[data-action=rerun-setup]")) renderSetup("rerun");
});

boot().catch((ex) => { $("#app").innerHTML = '<div class="center"><div class="card">Failed to load: ' + ex.message + "</div></div>"; });
