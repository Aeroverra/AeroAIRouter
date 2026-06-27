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

// ---------- setup wizard (multi-step; first-run + re-run) ----------
function renderSetup(mode, status) {
  const frag = tpl("tpl-setup");
  const rerun = mode === "rerun";
  const titleEl = $("[data-setup-title]", frag);
  const progressEl = $("[data-progress]", frag);
  const bodyEl = $("[data-body]", frag);
  const errEl = $("[data-err]", frag);
  const backBtn = $("[data-back]", frag);
  const nextBtn = $("[data-next]", frag);
  const finishBtn = $("[data-finish]", frag);
  const cancelBtn = $("[data-cancel]", frag);
  const c = state.config || {};

  const data = {
    setupCode: "", password: "", password2: "",
    botName: rerun ? getPath(c, "discord.wakeWord") || "" : "",
    DISCORD_TOKEN: "",
    ownerId: rerun ? getPath(c, "discord.ownerId") || "" : "",
    authMode: rerun ? getPath(c, "ai.auth.mode") || "auto" : "auto",
    ANTHROPIC_API_KEY: "", CLAUDE_CODE_OAUTH_TOKEN: "", BRAVE_API_KEY: "",
    model: rerun ? getPath(c, "ai.models.complex") || "claude-opus-4-8" : "claude-opus-4-8",
    emoji: rerun ? getPath(c, "persona.emoji") || "" : "",
    visibility: rerun ? getPath(c, "integrations.github.defaultVisibility") || "private" : "private",
    GITHUB_TOKEN: "", CLOUDFLARE_TOKEN: "",
  };

  // shared channel-picker state
  let setupToken = "";
  let setupGuilds = null, setupLoading = false, setupErr = null;
  const setupChannels = (rerun && Array.isArray(getPath(c, "discord.channels")))
    ? getPath(c, "discord.channels").map((x) => Object.assign({}, x)) : [];

  // ---- small builders ----
  const link = (t, href) => el("a", { href, target: "_blank", rel: "noopener", text: t });
  const code = (t) => el("code", { text: t });
  function field(labelText, inputEl, helpNodes) {
    const w = el("div", { class: "field" });
    w.appendChild(el("label", { text: labelText }));
    if (helpNodes) w.appendChild(el("div", { class: "hint" }, [].concat(helpNodes)));
    w.appendChild(inputEl);
    return w;
  }
  function txt(key, ph) { const i = el("input", { type: "text", value: data[key] || "", placeholder: ph || "" }); i.addEventListener("input", () => (data[key] = i.value)); return i; }
  function secret(key, ph) {
    const isSet = rerun && state.secrets && state.secrets[key];
    const i = el("input", { type: "password", value: data[key] || "", placeholder: isSet ? "•••••• (leave blank to keep)" : (ph || "") });
    i.addEventListener("input", () => (data[key] = i.value));
    return i;
  }

  // ---- channel picker (grouped by server) ----
  function resolveName(id) { if (setupGuilds) for (const g of setupGuilds) for (const ch of g.channels) if (ch.id === id) return { name: ch.name, guild: g.guildName }; return null; }
  function loadServers(box) {
    const token = setupToken || data.DISCORD_TOKEN.trim();
    if (!token) { setupErr = "Test your Discord token in the previous step first."; drawChans(box); return; }
    setupLoading = true; setupErr = null; drawChans(box);
    api("POST", "/api/discord/list-channels", { token })
      .then((r) => { setupGuilds = r.guilds || []; setupLoading = false; drawChans(box); })
      .catch((ex) => { setupLoading = false; setupErr = ex.message; drawChans(box); });
  }
  function drawChans(box) {
    box.innerHTML = "";
    setupChannels.forEach((r) => { const got = resolveName(r.id); if (got) { r.name = got.name; r.guild = got.guild; } });
    const groups = new Map();
    setupChannels.forEach((r, idx) => { const k = r.guild || "Other / not loaded"; if (!groups.has(k)) groups.set(k, []); groups.get(k).push({ r, idx }); });
    for (const [gname, items] of groups) {
      box.appendChild(el("div", { class: "chan-group", text: gname }));
      for (const { r, idx } of items) {
        const label = el("div", { class: "chan-label" }, [el("strong", { text: r.name ? "#" + r.name : r.id }), el("span", { class: "hint", text: "  (" + r.id + ")" })]);
        const mode = el("select");
        [["all", "respond to all"], ["addressed", "when addressed (@, reply, wake-word, owner)"], ["mention", "only when @-mentioned"], ["off", "off"]].forEach(([v, t]) => mode.appendChild(el("option", { value: v, text: t })));
        mode.value = r.mode || "addressed"; mode.addEventListener("change", () => (r.mode = mode.value));
        const rm = el("button", { type: "button", class: "ghost", text: "✕" });
        rm.addEventListener("click", () => { setupChannels.splice(idx, 1); drawChans(box); });
        box.appendChild(el("div", { class: "chan-row" }, [label, mode, rm]));
      }
    }
    if (setupLoading) box.appendChild(el("p", { class: "hint", text: "Loading servers…" }));
    else if (setupErr) box.appendChild(el("p", { class: "err", text: setupErr }));
    if (setupGuilds && setupGuilds.length) {
      const gsel = el("select"); gsel.appendChild(el("option", { value: "", text: "— server —" }));
      setupGuilds.forEach((g, i) => gsel.appendChild(el("option", { value: String(i), text: g.guildName })));
      const csel = el("select"); csel.disabled = true; csel.appendChild(el("option", { value: "", text: "— channel —" }));
      gsel.addEventListener("change", () => {
        csel.innerHTML = ""; csel.appendChild(el("option", { value: "", text: "— channel —" }));
        const g = setupGuilds[Number(gsel.value)];
        if (g) { csel.disabled = false; g.channels.filter((ch) => !setupChannels.some((r) => r.id === ch.id)).forEach((ch) => csel.appendChild(el("option", { value: ch.id, text: "#" + ch.name }))); } else csel.disabled = true;
      });
      const add = el("button", { type: "button", class: "ghost", text: "+ Add" });
      add.addEventListener("click", () => { const g = setupGuilds[Number(gsel.value)], id = csel.value; if (g && id && !setupChannels.some((r) => r.id === id)) { const ch = g.channels.find((x) => x.id === id); setupChannels.push({ id, name: ch ? ch.name : "", guild: g.guildName, mode: "addressed", respondToBots: false }); drawChans(box); } });
      box.appendChild(el("div", { class: "picker" }, [gsel, csel, add]));
    } else if (!setupLoading) {
      const lb = el("button", { type: "button", class: "ghost", text: setupErr ? "Retry" : "Load servers from Discord" });
      lb.addEventListener("click", () => loadServers(box));
      box.appendChild(el("div", { class: "list-row" }, [lb]));
    }
  }

  // ---- steps ----
  const steps = [];
  if (!rerun && status && status.needsPassword) {
    steps.push({
      title: "Admin password",
      render(b) {
        b.appendChild(el("p", { class: "wiz-intro", text: "This password protects the control panel — you'll log in with it from now on." }));
        b.appendChild(field("Setup code", txt("setupCode", "paste the code from the server console"), "Printed in the server console / journal when the UI started."));
        const p1 = el("input", { type: "password", value: data.password, placeholder: "at least 8 characters" }); p1.addEventListener("input", () => (data.password = p1.value));
        const p2 = el("input", { type: "password", value: data.password2 }); p2.addEventListener("input", () => (data.password2 = p2.value));
        b.appendChild(field("Admin password", p1));
        b.appendChild(field("Confirm password", p2));
      },
      validate() { if (!data.password || data.password.length < 8) return "Password must be at least 8 characters."; if (data.password !== data.password2) return "Passwords do not match."; return null; },
    });
  }
  steps.push({
    title: "Discord bot",
    render(b) {
      b.appendChild(el("p", { class: "wiz-intro" }, ["Create a bot and paste its token. ", link("Open the Discord Developer Portal ↗", "https://discord.com/developers/applications")]));
      b.appendChild(el("ol", { class: "wiz-list" }, [
        el("li", { text: "New Application → Bot → Reset Token → Copy." }),
        el("li", { text: "Bot → Privileged Gateway Intents → enable MESSAGE CONTENT INTENT." }),
        el("li", { text: "OAuth2 → URL Generator → scope “bot”, then invite it to your server." }),
      ]));
      const tokenInput = secret("DISCORD_TOKEN", "paste bot token");
      const testBtn = el("button", { type: "button", class: "ghost", text: "Test" });
      const checkOut = el("span", { class: "check" });
      testBtn.addEventListener("click", async () => {
        const t = data.DISCORD_TOKEN.trim();
        if (!t) { checkOut.textContent = "Enter a token first"; checkOut.className = "check bad"; return; }
        checkOut.textContent = "Checking…"; checkOut.className = "check";
        try { const r = await api("POST", "/api/check-discord", { token: t }); if (r.ok) { checkOut.textContent = "✓ Valid — " + r.username; checkOut.className = "check ok"; setupToken = t; setupGuilds = null; } else { checkOut.textContent = "✗ " + r.error; checkOut.className = "check bad"; } }
        catch (ex) { checkOut.textContent = "✗ " + ex.message; checkOut.className = "check bad"; }
      });
      b.appendChild(field("Discord bot token", el("div", { class: "row" }, [tokenInput, testBtn]), "Click Test to verify it works."));
      b.appendChild(checkOut);
      b.appendChild(field("Bot name", txt("botName", "e.g. Azula"), "Used as the wake word in busy channels and voice."));
      b.appendChild(field("Your Discord user ID", txt("ownerId", "your user ID"), "Discord → Settings → Advanced → Developer Mode ON, then right-click your name → Copy User ID."));
    },
    validate() { if (!rerun && !data.DISCORD_TOKEN.trim()) return "Discord bot token is required."; if (!data.ownerId.trim()) return "Your Discord user ID is required."; return null; },
  });
  steps.push({
    title: "Channels",
    render(b) {
      b.appendChild(el("p", { class: "wiz-intro", text: "Pick which channels the bot watches and how it responds. You can change this anytime." }));
      const box = el("div"); b.appendChild(box);
      drawChans(box);
      if (!setupGuilds && !setupLoading && (setupToken || data.DISCORD_TOKEN.trim())) loadServers(box);
    },
  });
  steps.push({
    title: "Claude",
    render(b) {
      b.appendChild(el("p", { class: "wiz-intro", text: "How the bot talks to Claude — a standard API key, or your Claude subscription via an OAuth token." }));
      const sel = el("select"); [["auto", "Auto (API key if set, else OAuth)"], ["apikey", "API key"], ["oauth", "OAuth setup-token"]].forEach(([v, t]) => sel.appendChild(el("option", { value: v, text: t }))); sel.value = data.authMode; sel.addEventListener("change", () => (data.authMode = sel.value));
      b.appendChild(field("Auth mode", sel));
      b.appendChild(field("Anthropic API key", secret("ANTHROPIC_API_KEY", "sk-ant-…"), ["Create one at ", link("console.anthropic.com ↗", "https://console.anthropic.com/settings/keys"), "."]));
      b.appendChild(field("Claude OAuth setup-token", secret("CLAUDE_CODE_OAUTH_TOKEN", "sk-ant-oat01-…"), ["Run ", code("claude setup-token"), " in a terminal — uses your Claude subscription."]));
      b.appendChild(field("Model", txt("model", "claude-opus-4-8")));
    },
    validate() {
      if (rerun) return null;
      if (!data.ANTHROPIC_API_KEY.trim() && !data.CLAUDE_CODE_OAUTH_TOKEN.trim()) return "Provide an Anthropic API key OR an OAuth setup-token.";
      if (data.authMode === "oauth" && !data.CLAUDE_CODE_OAUTH_TOKEN.trim()) return "OAuth mode needs the setup-token.";
      if (data.authMode === "apikey" && !data.ANTHROPIC_API_KEY.trim()) return "API-key mode needs the API key.";
      return null;
    },
  });
  steps.push({
    title: "Integrations (optional)",
    render(b) {
      b.appendChild(el("p", { class: "wiz-intro", text: "Optional credentials the bot can use. Skip any you don't need — add more later." }));
      b.appendChild(field("Brave Search API key", secret("BRAVE_API_KEY", "enables web search"), ["Free key at ", link("brave.com/search/api ↗", "https://brave.com/search/api/"), "."]));
      b.appendChild(field("GitHub token", secret("GITHUB_TOKEN", "ghp_… / github_pat_…"), ["Create at ", link("github.com/settings/tokens ↗", "https://github.com/settings/tokens"), ". Add more later in Integrations."]));
      const vis = el("select"); [["private", "Private"], ["public", "Public"]].forEach(([v, t]) => vis.appendChild(el("option", { value: v, text: t }))); vis.value = data.visibility; vis.addEventListener("change", () => (data.visibility = vis.value));
      b.appendChild(field("New GitHub repos default to", vis));
      b.appendChild(field("Cloudflare API token", secret("CLOUDFLARE_TOKEN", "optional"), ["Create at ", link("Cloudflare → API Tokens ↗", "https://dash.cloudflare.com/profile/api-tokens"), "."]));
    },
  });
  steps.push({
    title: "Finish",
    render(b) {
      b.appendChild(el("p", { class: "wiz-intro", text: "Last touches, then save." }));
      b.appendChild(field("Signature emoji", txt("emoji", "e.g. a custom emoji, or blank"), "Appended to messages. Leave blank for none."));
      b.appendChild(el("p", { class: "hint", text: "Click Finish to save. Restart the bot (dashboard button) to apply changes." }));
    },
  });

  // ---- step engine ----
  let idx = 0;
  function renderStep() {
    errEl.textContent = "";
    const step = steps[idx];
    titleEl.textContent = rerun ? "Re-run setup" : "Set up AeroAIRouter";
    progressEl.innerHTML = "";
    const dots = el("div", { class: "dots" });
    steps.forEach((s, i) => dots.appendChild(el("span", { class: "dot" + (i === idx ? " active" : "") + (i < idx ? " done" : "") })));
    progressEl.appendChild(dots);
    progressEl.appendChild(el("div", { class: "step-label", text: "Step " + (idx + 1) + " of " + steps.length + " — " + step.title }));
    bodyEl.innerHTML = "";
    step.render(bodyEl);
    backBtn.hidden = idx === 0;
    nextBtn.hidden = idx === steps.length - 1;
    finishBtn.hidden = idx !== steps.length - 1;
    cancelBtn.hidden = !rerun;
  }
  function go(delta) {
    if (delta > 0) { const v = steps[idx].validate && steps[idx].validate(); if (v) { errEl.textContent = v; return; } }
    idx = Math.max(0, Math.min(steps.length - 1, idx + delta));
    renderStep();
  }
  backBtn.addEventListener("click", () => go(-1));
  nextBtn.addEventListener("click", () => go(1));
  cancelBtn.addEventListener("click", () => openDash());
  finishBtn.addEventListener("click", submit);

  async function submit() {
    errEl.textContent = "";
    try {
      for (const s of steps) { const v = s.validate && s.validate(); if (v) { errEl.textContent = v; return; } }
      const patch = {};
      const set = (p, v) => { if (v !== "" && v !== undefined) setPath(patch, p, v); };
      set("discord.wakeWord", data.botName.trim());
      set("discord.ownerId", data.ownerId.trim());
      set("ai.auth.mode", data.authMode);
      if (data.model.trim()) { set("ai.models.complex", data.model.trim()); set("ai.models.casual", data.model.trim()); }
      setPath(patch, "persona.emoji", data.emoji);
      const owner = data.ownerId.trim();
      if (owner) setPath(patch, "discord.people." + owner, { name: "Owner", trust: "owner" });
      if (setupChannels.length) setPath(patch, "discord.channels", setupChannels.map((r) => ({ id: r.id, name: r.name, guild: r.guild, mode: r.mode || "addressed", respondToBots: !!r.respondToBots })));
      setPath(patch, "integrations.github.defaultVisibility", data.visibility);
      if (data.GITHUB_TOKEN.trim()) {
        const tokens = (getPath(state.config, "integrations.github.tokens") || []).slice();
        if (!tokens.some((t) => t.key === "GITHUB_TOKEN")) tokens.push({ label: "default", key: "GITHUB_TOKEN" });
        setPath(patch, "integrations.github.tokens", tokens);
      }
      if (data.CLOUDFLARE_TOKEN.trim()) setPath(patch, "integrations.cloudflare.enabled", true);

      const secrets = {};
      for (const k of ["DISCORD_TOKEN", "ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "BRAVE_API_KEY", "GITHUB_TOKEN", "CLOUDFLARE_TOKEN"]) if (data[k] && data[k].trim()) secrets[k] = data[k].trim();

      if (rerun) {
        const merged = deepMerge(structuredClone(state.config), patch);
        await api("PUT", "/api/config", { config: merged });
        if (Object.keys(secrets).length) await api("PUT", "/api/secrets", { secrets });
        toast("Setup saved"); await openDash();
      } else {
        const res = await api("POST", "/api/setup", { setupCode: data.setupCode.trim() || undefined, password: status && status.needsPassword ? data.password : undefined, config: patch, secrets });
        state.csrf = res.csrf; toast("Setup complete"); await openDash();
      }
    } catch (ex) { errEl.textContent = ex.message; }
  }

  mount(frag);
  renderStep();
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
  try { const pd = await api("GET", "/api/plugins"); state.pluginList = pd.plugins || []; state.pluginSecrets = pd.secrets || {}; }
  catch { state.pluginList = []; state.pluginSecrets = {}; }
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
  const addNav = (id, title, opts = {}) => {
    const b = el("button", { text: title, class: (id === state.active ? "active " : "") + (opts.child ? "subnav" : "") });
    b.addEventListener("click", () => { if (confirmLeave()) { state.active = id; renderDash(); } });
    nav.appendChild(b);
  };
  for (const sec of state.schema) addNav(sec.id, sec.title);
  // Plugins (expands into per-plugin config sub-tabs when active)
  addNav("__plugins", "Plugins");
  const onPlugins = state.active === "__plugins" || (state.active || "").startsWith("__plugin:");
  if (onPlugins) {
    for (const p of state.pluginList || []) {
      if (!(p.configSchema || []).length) continue;
      addNav("__plugin:" + p.name, "› " + (p.label || p.name), { child: true });
    }
  }
  addNav("__mcp", "MCP");
  addNav("__raw", "Raw JSON");

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
  if (state.active === "__plugins") return renderPluginsList(c);
  if ((state.active || "").startsWith("__plugin:")) return renderPluginConfig(c, state.active.slice("__plugin:".length));
  if (state.active === "__mcp") return renderMcp(c);
  if (state.active === "__raw") return renderRaw(c);
  const sec = state.schema.find((s) => s.id === state.active);
  if (!sec) return;
  c.appendChild(el("h2", { text: sec.title }));
  if (sec.help) c.appendChild(el("p", { class: "section-help", text: sec.help }));
  for (const f of sec.fields) {
    if (f.advanced && !state.advanced) continue;
    c.appendChild(renderField(f));
  }
  if (sec.id === "network") {
    c.appendChild(el("p", { class: "hint", text: "Save first, then apply. Applying restarts the UI — if you changed the address or port, reconnect at the new URL." }));
    const btn = el("button", { text: "Apply network changes (restart UI)" });
    btn.addEventListener("click", restartUi);
    c.appendChild(btn);
    c.appendChild(el("h3", { text: "Access & URLs" }));
    c.appendChild(el("p", { class: "section-help", text: "The UI is reachable at these addresses (LAN + Tailscale)." }));
    appendAccessUrls(c);
  }
}

async function restartUi() {
  if (state.dirty && !confirm("Unsaved changes won't be applied unless you Save first. Restart the UI anyway?")) return;
  if (!confirm("Restart the UI now? You may need to reconnect at a new address/port.")) return;
  try { await api("POST", "/api/ui/restart"); toast("UI restarting… reconnect if the address/port changed."); }
  catch (ex) { toast(ex.message, true); }
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
    case "binds": return renderBinds(wrap, f, val);
    case "githubtokens": return renderGithubTokens(wrap, f, val);
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

// Eye toggle that fetches and shows a stored secret value (admin-only). Setting
// the value programmatically does NOT fire 'input', so a reveal alone never marks
// the field dirty or overwrites the stored secret on save.
function revealBtn(input, getKey) {
  let shown = false;
  const b = el("button", { type: "button", class: "ghost reveal", text: "👁" });
  b.title = "Show / hide the stored value";
  b.addEventListener("click", async () => {
    const key = typeof getKey === "function" ? getKey() : getKey;
    if (!key) return;
    if (shown) { input.type = "password"; input.value = ""; shown = false; b.textContent = "👁"; return; }
    try {
      const r = await api("POST", "/api/secrets/reveal", { key });
      input.value = r.value; input.type = "text"; shown = true; b.textContent = "🙈";
    } catch (ex) { toast(ex.message, true); }
  });
  return b;
}

function renderSecret(wrap, f) {
  const isSet = !!state.secrets[f.secret];
  const badge = el("span", { class: "badge" + (isSet ? " set" : ""), text: isSet ? "set" : "not set" });
  const i = el("input", { type: "password", placeholder: isSet ? "•••••• (leave blank to keep)" : "not set" });
  i.addEventListener("input", () => { state.secretEdits[f.secret] = i.value; markDirty(); });
  const row = el("div", { class: "row" }, [i, isSet ? revealBtn(i, f.secret) : null, badge]);
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

function renderBinds(wrap, f, val) {
  let rows = Array.isArray(val) ? val.slice() : (typeof val === "string" && val ? [val] : []);
  if (rows.length === 0) rows = ["0.0.0.0"];
  const container = el("div");
  wrap.appendChild(container);
  function commit() { setPath(state.config, f.path, rows.slice()); markDirty(); }
  function draw() {
    container.innerHTML = "";
    // current binds as chips
    const cur = el("div", { class: "suggestions" });
    rows.forEach((addr, idx) => {
      const x = el("button", { type: "button", class: "ghost", text: "✕" });
      x.addEventListener("click", () => { rows.splice(idx, 1); if (rows.length === 0) rows.push("0.0.0.0"); draw(); commit(); });
      cur.appendChild(el("span", { class: "bind-chip" }, [el("span", { text: addr }), x]));
    });
    container.appendChild(cur);
    if (rows.includes("0.0.0.0")) container.appendChild(el("p", { class: "hint", text: "0.0.0.0 already covers all interfaces — other addresses are ignored while it's listed." }));

    // clickable suggestions
    const sug = el("div", { class: "suggestions" });
    container.appendChild(sug);
    if (!state.netAvailable) {
      sug.appendChild(el("span", { class: "hint", text: "loading available addresses…" }));
      api("GET", "/api/netinfo").then((r) => { state.netAvailable = r.available || []; draw(); }).catch(() => {});
    } else {
      sug.appendChild(el("span", { class: "hint", text: "Click to add: " }));
      const choices = state.netAvailable.filter((s) => !rows.includes(s.address));
      if (!choices.length) sug.appendChild(el("span", { class: "hint", text: "(all detected addresses added)" }));
      choices.forEach((s) => {
        const b = el("button", { type: "button", class: "ghost chip", text: "+ " + s.address + "  " + s.label });
        b.addEventListener("click", () => { if (!rows.includes(s.address)) { rows.push(s.address); draw(); commit(); } });
        sug.appendChild(b);
      });
    }

    // manual add
    const inp = el("input", { type: "text", placeholder: "add an address manually" });
    const add = el("button", { type: "button", class: "ghost", text: "+ Add" });
    add.addEventListener("click", () => { const v = inp.value.trim(); if (v && !rows.includes(v)) { rows.push(v); draw(); commit(); } });
    container.appendChild(el("div", { class: "list-row" }, [inp, add]));
  }
  draw();
  return wrap;
}

function renderGithubTokens(wrap, f, val) {
  const rows = Array.isArray(val) ? val.map((t) => Object.assign({}, t)) : [];
  const container = el("div");
  wrap.appendChild(container);
  function commit() {
    setPath(state.config, f.path, rows.filter((r) => r.key).map((r) => ({ label: r.label || r.key, key: r.key })));
    markDirty();
  }
  function ensureKey(r) {
    if (r.key) return;
    const slug = (r.label || "").toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
    r.key = slug ? "GITHUB_TOKEN_" + slug : "GITHUB_TOKEN_" + (rows.indexOf(r) + 1);
  }
  function draw() {
    container.innerHTML = "";
    rows.forEach((r, idx) => {
      ensureKey(r);
      const label = el("input", { type: "text", value: r.label || "", placeholder: "label (e.g. personal)" });
      const keyHint = el("div", { class: "hint", text: "env var: " + r.key });
      label.addEventListener("input", () => { r.label = label.value; commit(); });
      const isSet = !!(state.secrets && state.secrets[r.key]);
      const tok = el("input", { type: "password", placeholder: isSet ? "•••••• (leave blank to keep)" : "paste token" });
      tok.addEventListener("input", () => { state.secretEdits[r.key] = tok.value; markDirty(); });
      const rm = el("button", { type: "button", class: "ghost", text: "✕" });
      rm.addEventListener("click", () => { state.secretEdits[r.key] = null; rows.splice(idx, 1); draw(); commit(); });
      container.appendChild(el("div", { class: "list-row" }, [label, tok, rm]));
      container.appendChild(keyHint);
    });
    const add = el("button", { type: "button", class: "ghost", text: "+ Add GitHub token" });
    add.addEventListener("click", () => { rows.push({ label: "", key: "" }); draw(); });
    container.appendChild(add);
  }
  draw();
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
  wrap.appendChild(container);

  function commit() {
    setPath(
      state.config,
      f.path,
      rows.filter((r) => r.id).map((r) => ({ id: r.id, name: r.name, guild: r.guild, mode: r.mode || "addressed", respondToBots: !!r.respondToBots }))
    );
    markDirty();
  }
  function resolve(id) {
    if (!state.discordChannels) return null;
    for (const g of state.discordChannels) for (const ch of g.channels) if (ch.id === id) return { name: ch.name, guild: g.guildName };
    return null;
  }

  function load(force) {
    if (state.discordChannelsLoading) return;
    if (state.discordChannels && !force) return;
    state.discordChannelsLoading = true;
    state.discordChannelsError = null;
    draw();
    api("GET", "/api/discord/channels")
      .then((r) => { state.discordChannels = r.guilds || []; state.discordChannelsLoading = false; draw(); })
      .catch((ex) => { state.discordChannelsLoading = false; state.discordChannelsError = ex.message; draw(); });
  }

  function draw() {
    container.innerHTML = "";

    // configured channels — resolve names, then group by server
    rows.forEach((r) => { const got = resolve(r.id); if (got) { r.name = got.name; r.guild = got.guild; } });
    const groups = new Map();
    rows.forEach((r, idx) => {
      const key = r.guild || "Other / not loaded";
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push({ r, idx });
    });
    for (const [guildName, items] of groups) {
      container.appendChild(el("div", { class: "chan-group", text: guildName }));
      for (const { r, idx } of items) {
        const label = el("div", { class: "chan-label" }, [
          el("strong", { text: r.name ? "#" + r.name : r.id }),
          el("span", { class: "hint", text: "  (" + r.id + ")" }),
        ]);
        const mode = el("select");
        [["all", "respond to all"], ["addressed", "when addressed (@, reply, wake-word, owner)"], ["mention", "only when @-mentioned"], ["off", "off"]].forEach(([v, t]) => mode.appendChild(el("option", { value: v, text: t })));
        mode.value = r.mode || "addressed";
        mode.addEventListener("change", () => { r.mode = mode.value; commit(); });
        const botsCb = el("input", { type: "checkbox" }); botsCb.checked = !!r.respondToBots; botsCb.style.width = "auto";
        botsCb.addEventListener("change", () => { r.respondToBots = botsCb.checked; commit(); });
        const botsL = el("label", { class: "switch" }, [botsCb, " answer bots"]);
        const rm = el("button", { class: "ghost", text: "✕" });
        rm.addEventListener("click", () => { rows.splice(idx, 1); draw(); commit(); });
        container.appendChild(el("div", { class: "chan-row" }, [label, mode, botsL, rm]));
      }
    }
    if (rows.length === 0) container.appendChild(el("p", { class: "hint", text: "No channels configured yet — add one below." }));

    // status line
    if (state.discordChannelsLoading) container.appendChild(el("p", { class: "hint", text: "Loading your servers from Discord…" }));
    else if (state.discordChannelsError) container.appendChild(el("p", { class: "err", text: "Couldn't load channels: " + state.discordChannelsError }));

    // two-step picker: server -> channel -> add
    if (state.discordChannels && state.discordChannels.length) {
      const guildSel = el("select");
      guildSel.appendChild(el("option", { value: "", text: "— select a server —" }));
      state.discordChannels.forEach((g, i) => guildSel.appendChild(el("option", { value: String(i), text: g.guildName })));
      const chanSel = el("select"); chanSel.disabled = true; chanSel.appendChild(el("option", { value: "", text: "— select a channel —" }));
      guildSel.addEventListener("change", () => {
        chanSel.innerHTML = "";
        chanSel.appendChild(el("option", { value: "", text: "— select a channel —" }));
        const g = state.discordChannels[Number(guildSel.value)];
        if (g) {
          chanSel.disabled = false;
          g.channels.filter((ch) => !rows.some((r) => r.id === ch.id)).forEach((ch) => chanSel.appendChild(el("option", { value: ch.id, text: "#" + ch.name })));
        } else chanSel.disabled = true;
      });
      const addBtn = el("button", { class: "ghost", text: "+ Add channel" });
      addBtn.addEventListener("click", () => {
        const g = state.discordChannels[Number(guildSel.value)];
        const id = chanSel.value;
        if (g && id && !rows.some((r) => r.id === id)) {
          const ch = g.channels.find((c) => c.id === id);
          rows.push({ id, name: ch ? ch.name : "", guild: g.guildName, mode: "addressed", respondToBots: false });
          draw(); commit();
        }
      });
      const refresh = el("button", { class: "ghost", text: "↻ Refresh" });
      refresh.addEventListener("click", () => load(true));
      container.appendChild(el("div", { class: "picker" }, [guildSel, chanSel, addBtn, refresh]));
    } else if (!state.discordChannelsLoading) {
      const loadBtn = el("button", { class: "ghost", text: state.discordChannelsError ? "Retry" : "Load servers from Discord" });
      loadBtn.addEventListener("click", () => load(true));
      container.appendChild(el("div", { class: "list-row" }, [loadBtn]));
    }

    // manual fallback
    const manual = el("button", { class: "ghost", text: "+ Add by ID" });
    manual.addEventListener("click", () => { const id = prompt("Channel ID:"); if (id && id.trim()) { rows.push({ id: id.trim(), mode: "addressed", respondToBots: false }); draw(); commit(); } });
    container.appendChild(el("div", { class: "list-row" }, [manual]));
  }

  draw();
  load(false); // auto-load on open
  return wrap;
}

// ---------- plugins ----------
function statusBadge(status, error) {
  const cls = status === "connected" ? "badge set" : (status === "error" ? "badge bad" : "badge");
  const b = el("span", { class: cls, text: status });
  if (error) b.title = error;
  return b;
}

function renderPluginsList(c) {
  c.appendChild(el("h2", { text: "Plugins" }));
  c.appendChild(el("p", { class: "section-help", text: "Turn plugins on or off, or open one to configure it. Configurable plugins also appear in the menu on the left. Restart the bot to apply changes." }));
  const list = state.pluginList || [];
  if (!list.length) { c.appendChild(el("p", { class: "hint", text: "No plugins found." })); return; }

  for (const p of list) {
    const card = el("div", { class: "plugin-card" });
    const cb = el("input", { type: "checkbox" }); cb.checked = !!p.enabled; cb.style.width = "auto";
    cb.addEventListener("change", async () => {
      try { await api("PUT", "/api/plugins/" + p.name, { enabled: cb.checked }); p.enabled = cb.checked; toast((cb.checked ? "Enabled " : "Disabled ") + (p.label || p.name) + ". Restart the bot to apply."); }
      catch (ex) { cb.checked = !cb.checked; toast(ex.message, true); }
    });
    card.appendChild(el("div", { class: "plugin-head" }, [
      el("div", {}, [
        el("strong", { text: p.label || p.name }),
        p.hasMcp ? el("span", { class: "badge", text: "MCP" }) : null,
        p.broken ? el("span", { class: "badge bad", text: "error" }) : null,
      ]),
      el("label", { class: "switch" }, [cb, " enabled"]),
    ]));
    if (p.description) card.appendChild(el("p", { class: "hint", text: p.description }));
    if (p.broken) card.appendChild(el("p", { class: "err", text: p.error || "failed to load" }));
    if ((p.configSchema || []).length) {
      const cfgBtn = el("button", { class: "ghost", text: "Configure →" });
      cfgBtn.addEventListener("click", () => { if (confirmLeave()) { state.active = "__plugin:" + p.name; renderDash(); } });
      card.appendChild(el("div", { class: "row" }, [cfgBtn]));
    } else {
      card.appendChild(el("p", { class: "hint", text: "No configurable options." }));
    }
    c.appendChild(card);
  }
}

function renderPluginConfig(c, name) {
  const p = (state.pluginList || []).find((x) => x.name === name);
  const back = el("button", { class: "ghost", text: "← All plugins" });
  back.addEventListener("click", () => { if (confirmLeave()) { state.active = "__plugins"; renderDash(); } });
  c.appendChild(back);
  if (!p) { c.appendChild(el("p", { class: "err", text: "Plugin not found." })); return; }
  c.appendChild(el("h2", { text: p.label || p.name }));
  if (p.description) c.appendChild(el("p", { class: "section-help", text: p.description }));
  if (p.broken) { c.appendChild(el("p", { class: "err", text: p.error || "failed to load" })); return; }

  const conf = Object.assign({}, p.defaults || {}, p.config || {});
  const secretEdits = {};
  const secrets = state.pluginSecrets || {};

  const enableCb = el("input", { type: "checkbox" }); enableCb.checked = !!p.enabled; enableCb.style.width = "auto";
  c.appendChild(el("div", { class: "field" }, [el("label", { class: "switch" }, [enableCb, " plugin enabled"])]));

  for (const f of p.configSchema || []) c.appendChild(pluginField(f, conf, secrets, secretEdits, p.name));

  const saveBtn = el("button", { text: "Save" });
  const status = el("span", { class: "hint" });
  saveBtn.addEventListener("click", async () => {
    saveBtn.disabled = true; status.textContent = "Saving…";
    try {
      await api("PUT", "/api/plugins/" + p.name, { enabled: enableCb.checked, config: conf });
      const sec = {};
      for (const [k, v] of Object.entries(secretEdits)) { if (v === null) sec[k] = null; else if (v && v.trim()) sec[k] = v.trim(); }
      if (Object.keys(sec).length) {
        await api("PUT", "/api/secrets", { secrets: sec });
        for (const k of Object.keys(sec)) secrets[k] = sec[k] !== null;
      }
      p.enabled = enableCb.checked; p.config = conf;
      status.textContent = ""; toast("Saved " + (p.label || p.name) + ". Restart the bot to apply.");
    } catch (ex) { status.textContent = ""; toast(ex.message, true); }
    saveBtn.disabled = false;
  });
  c.appendChild(el("div", { class: "row" }, [saveBtn, status]));
}

function pluginField(f, conf, secrets, secretEdits, pluginName) {
  const wrap = el("div", { class: "field" });
  wrap.appendChild(el("label", { text: f.label }));
  if (f.help) wrap.appendChild(el("span", { class: "hint", text: f.help }));

  if (f.type === "tokens") return pluginTokensField(wrap, f, conf, secrets, secretEdits, pluginName);

  if (f.secret) {
    const isSet = !!secrets[f.secret];
    const badge = el("span", { class: "badge" + (isSet ? " set" : ""), text: isSet ? "set" : "not set" });
    const i = el("input", { type: "password", placeholder: isSet ? "•••••• (leave blank to keep)" : "not set" });
    i.addEventListener("input", () => { secretEdits[f.secret] = i.value; });
    wrap.appendChild(el("div", { class: "row" }, [i, isSet ? revealBtn(i, f.secret) : null, badge]));
    return wrap;
  }
  const val = conf[f.path];
  if (f.type === "boolean") {
    const cb = el("input", { type: "checkbox" }); cb.checked = !!val; cb.style.width = "auto";
    cb.addEventListener("change", () => { conf[f.path] = cb.checked; });
    wrap.appendChild(el("label", { class: "switch" }, [cb, " enabled"]));
  } else if (f.type === "select") {
    const s = el("select");
    for (const o of f.options) s.appendChild(el("option", { value: o, text: o }));
    s.value = val == null ? f.options[0] : val;
    s.addEventListener("change", () => { conf[f.path] = s.value; });
    wrap.appendChild(s);
  } else if (f.type === "number") {
    const i = el("input", { type: "text", value: val == null ? "" : String(val) });
    i.addEventListener("input", () => { const n = Number(i.value); conf[f.path] = i.value === "" ? undefined : (isNaN(n) ? i.value : n); });
    wrap.appendChild(i);
  } else {
    const i = el("input", { type: "text", value: val == null ? "" : String(val) });
    i.addEventListener("input", () => { conf[f.path] = i.value; });
    wrap.appendChild(i);
  }
  return wrap;
}

// Multi-token field: a list of {label, key} with per-token value entry, reveal,
// and a Check button that asks the plugin to report the token's scopes.
function pluginTokensField(wrap, f, conf, secrets, secretEdits, pluginName) {
  const prefix = f.keyPrefix || "TOKEN";
  const rows = Array.isArray(conf[f.path]) ? conf[f.path].map((t) => Object.assign({}, t)) : [];
  if (!rows.length) rows.push({ label: "default", key: prefix });
  const box = el("div");
  wrap.appendChild(box);

  function ensureKey(r, idx) {
    if (r.key) return;
    if (idx === 0) { r.key = prefix; return; }
    const slug = (r.label || "").toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
    r.key = prefix + "_" + (slug || (idx + 1));
  }
  function commit() {
    conf[f.path] = rows.filter((r) => r.key).map((r) => ({ label: r.label || r.key, key: r.key }));
  }
  async function check(r, typed, out) {
    out.textContent = "Checking…"; out.className = "hint";
    try {
      const body = typed && typed.trim() ? { token: typed.trim() } : { key: r.key };
      const res = await api("POST", "/api/plugins/" + pluginName + "/check-token", body);
      if (!res.ok) { out.textContent = "✗ " + (res.error || "invalid"); out.className = "check bad"; return; }
      const scopes = (res.scopes && res.scopes.length) ? res.scopes.join(", ") : (res.note || "no scopes reported");
      out.innerHTML = "";
      out.appendChild(el("span", { class: "check ok", text: "✓ " + (res.identity || "valid") }));
      out.appendChild(el("div", { class: "hint", text: "scopes: " + scopes }));
    } catch (ex) { out.textContent = "✗ " + ex.message; out.className = "check bad"; }
  }

  function draw() {
    box.innerHTML = "";
    rows.forEach((r, idx) => {
      ensureKey(r, idx);
      const label = el("input", { type: "text", value: r.label || "", placeholder: "label (e.g. read-only)" });
      label.addEventListener("input", () => { r.label = label.value; commit(); });
      const isSet = !!secrets[r.key];
      const tok = el("input", { type: "password", placeholder: isSet ? "•••••• (leave blank to keep)" : "paste token" });
      tok.addEventListener("input", () => { secretEdits[r.key] = tok.value; });
      const out = el("div", { class: "hint" });
      const checkBtn = el("button", { type: "button", class: "ghost", text: "Check" });
      checkBtn.addEventListener("click", () => check(r, tok.value, out));
      const rm = el("button", { type: "button", class: "ghost", text: "✕" });
      rm.addEventListener("click", () => { secretEdits[r.key] = null; rows.splice(idx, 1); draw(); commit(); });
      const controls = [label, tok, isSet ? revealBtn(tok, r.key) : null, checkBtn, rm].filter(Boolean);
      box.appendChild(el("div", { class: "list-row" }, controls));
      box.appendChild(el("div", { class: "hint", text: "env var: " + r.key }));
      box.appendChild(out);
    });
    const add = el("button", { type: "button", class: "ghost", text: "+ Add token" });
    add.addEventListener("click", () => { rows.push({ label: "", key: "" }); draw(); commit(); });
    box.appendChild(add);
  }
  draw();
  commit();
  return wrap;
}

// ---------- MCP servers ----------
function renderMcp(c) {
  c.appendChild(el("h2", { text: "MCP Servers" }));
  c.appendChild(el("p", { class: "section-help", text: "Model Context Protocol servers expose external tools to the bot. Plugin-provided servers are managed by their plugin; you can also add your own. Changes apply on the next bot restart." }));
  const host = el("div");
  c.appendChild(host);
  host.appendChild(el("p", { class: "hint", text: "Loading…" }));

  api("GET", "/api/mcp").then((data) => {
    host.innerHTML = "";
    const servers = data.servers || [];
    if (!data.botRunning) host.appendChild(el("p", { class: "hint", text: "Live status/tools appear once the bot has started with these settings." }));

    // managed (plugin) servers — read-only
    const managed = servers.filter((s) => s.managed);
    host.appendChild(el("h3", { text: "From plugins (managed)" }));
    if (!managed.length) host.appendChild(el("p", { class: "hint", text: "No plugin is running an MCP server. Enable one under Plugins." }));
    for (const s of managed) host.appendChild(mcpServerView(s, true));

    // direct servers — editable
    host.appendChild(el("h3", { text: "Your servers" }));
    const direct = servers.filter((s) => !s.managed).map(cloneServer);
    const listBox = el("div");
    host.appendChild(listBox);

    function draw() {
      listBox.innerHTML = "";
      direct.forEach((s, idx) => listBox.appendChild(mcpServerEditor(s, () => { direct.splice(idx, 1); draw(); })));
      if (!direct.length) listBox.appendChild(el("p", { class: "hint", text: "No custom MCP servers yet." }));
    }
    draw();

    const addBtn = el("button", { class: "ghost", text: "+ Add MCP server" });
    addBtn.addEventListener("click", () => { direct.push({ name: "", command: "", args: [], env: {}, enabled: true, trust: "owner" }); draw(); });
    const saveBtn = el("button", { text: "Save servers" });
    saveBtn.addEventListener("click", async () => {
      try {
        const payload = direct.map((s) => ({
          name: (s.name || "").trim(), command: (s.command || "").trim(),
          args: s._argsText != null ? s._argsText.split("\n").map((x) => x.trim()).filter(Boolean) : (s.args || []),
          env: s._envText != null ? parseEnvLines(s._envText) : (s.env || {}),
          enabled: s.enabled !== false, trust: s.trust || "owner",
        }));
        await api("PUT", "/api/mcp/servers", { servers: payload });
        toast("Saved. Restart the bot to apply.");
      } catch (ex) { toast(ex.message, true); }
    });
    host.appendChild(el("div", { class: "row" }, [addBtn, saveBtn]));
  }).catch((ex) => { host.innerHTML = ""; host.appendChild(el("p", { class: "err", text: ex.message })); });
}

function cloneServer(s) {
  return {
    name: s.name, command: s.command || "", args: (s.args || []).slice(), env: Object.assign({}, s.env || {}),
    enabled: s.enabled !== false, trust: s.trust || "owner",
    _argsText: (s.args || []).join("\n"), _envText: envToLines(s.env || {}),
  };
}
function envToLines(env) { return Object.entries(env).map(([k, v]) => k + "=" + v).join("\n"); }
function parseEnvLines(text) {
  const out = {};
  for (const line of text.split("\n")) {
    const t = line.trim(); if (!t) continue;
    const eq = t.indexOf("="); if (eq < 1) continue;
    out[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
  }
  return out;
}

function toolsList(s) {
  const box = el("div", { class: "mcp-tools" });
  if (!s.tools || !s.tools.length) { box.appendChild(el("span", { class: "hint", text: s.status === "connected" ? "(no tools)" : "tools listed once running" })); return box; }
  for (const t of s.tools) box.appendChild(el("div", { class: "hint" }, [el("code", { text: t.registeredName || t.name }), t.description ? (" — " + t.description) : ""]));
  return box;
}

function mcpServerView(s, managed) {
  const card = el("div", { class: "plugin-card" });
  card.appendChild(el("div", { class: "plugin-head" }, [
    el("div", {}, [el("strong", { text: s.label || s.name }), statusBadge(s.status, s.error)]),
    managed ? el("span", { class: "hint", text: "managed by the " + s.plugin + " plugin" }) : null,
  ]));
  if (s.error) card.appendChild(el("p", { class: "err", text: s.error }));
  if (managed) card.appendChild(el("p", { class: "hint", text: "Configure it under the Plugins tab." }));
  card.appendChild(toolsList(s));
  return card;
}

function mcpServerEditor(s, onRemove) {
  const card = el("div", { class: "plugin-card" });
  const name = el("input", { type: "text", value: s.name || "", placeholder: "name (letters/digits/-/_)" });
  name.addEventListener("input", () => { s.name = name.value; });
  const rm = el("button", { class: "ghost", text: "✕" });
  rm.addEventListener("click", onRemove);
  card.appendChild(el("div", { class: "plugin-head" }, [
    el("div", { class: "row" }, [name, statusBadge(s.status || "new", s.error)]), rm,
  ]));

  const cmd = el("input", { type: "text", value: s.command || "", placeholder: "command, e.g. npx or node" });
  cmd.addEventListener("input", () => { s.command = cmd.value; });
  card.appendChild(field2("Command", cmd, "The executable to launch (stdio MCP server)."));

  const args = el("textarea", { placeholder: "one argument per line\ne.g. -y\n@modelcontextprotocol/server-filesystem" });
  args.value = s._argsText != null ? s._argsText : (s.args || []).join("\n");
  args.style.minHeight = "70px";
  args.addEventListener("input", () => { s._argsText = args.value; });
  card.appendChild(field2("Arguments", args, "One per line."));

  const env = el("textarea", { placeholder: "KEY=value, one per line\nuse KEY=${SECRET_NAME} to pull from secrets.env" });
  env.value = s._envText != null ? s._envText : envToLines(s.env || {});
  env.style.minHeight = "60px";
  env.addEventListener("input", () => { s._envText = env.value; });
  card.appendChild(field2("Environment", env, "KEY=value per line. Reference a secret without storing it here: KEY=${MY_SECRET}."));

  const enabledCb = el("input", { type: "checkbox" }); enabledCb.checked = s.enabled !== false; enabledCb.style.width = "auto";
  enabledCb.addEventListener("change", () => { s.enabled = enabledCb.checked; });
  const trust = el("select");
  ["owner", "elevated", "light"].forEach((t) => trust.appendChild(el("option", { value: t, text: "trust: " + t })));
  trust.value = s.trust || "owner";
  trust.addEventListener("change", () => { s.trust = trust.value; });
  card.appendChild(el("div", { class: "row" }, [el("label", { class: "switch" }, [enabledCb, " enabled"]), trust]));
  if (s.tools && s.tools.length) card.appendChild(toolsList(s));
  return card;
}

function field2(labelText, inputEl, help) {
  const w = el("div", { class: "field" });
  w.appendChild(el("label", { text: labelText }));
  if (help) w.appendChild(el("span", { class: "hint", text: help }));
  w.appendChild(inputEl);
  return w;
}

// ---------- virtual sections ----------
function appendAccessUrls(c) {
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
    for (const [k, v] of Object.entries(state.secretEdits)) {
      if (v === null) secretUpdates[k] = null;           // delete
      else if (v && v.trim()) secretUpdates[k] = v.trim(); // set
    }
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
