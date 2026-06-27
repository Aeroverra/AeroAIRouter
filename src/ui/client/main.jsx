import { render } from "preact";
import { useState, useEffect, useRef } from "preact/hooks";
import "./styles.css";
import { api } from "./api.js";
import { S, dirtyScopes, confirmDialog, toast, applyTheme } from "./store.js";
import { boot, saveAll, discardAll, reloadPlugins } from "./actions.js";
import { Btn, IconBtn, Icon, Switch, Spinner, ToastHost, DialogHost } from "./ui.jsx";
import { Login, SetupWizard, Dashboard, SchemaSection, RawJson, restartBot, changePassword } from "./views.jsx";
import { PluginsList, PluginConfig, McpView } from "./plugins.jsx";

const SECTION_ICONS = { essentials: "cog", discord: "discord", persona: "persona", review: "review", update: "update", network: "network" };

function App() {
  if (S.booting.value) return <div class="center-load"><Spinner size={26} /></div>;
  if (S.needsSetup.value) return <><SetupWizard status={S.setupStatus.value || {}} /><DialogHost /><ToastHost /></>;
  if (!S.authed.value) return <><Login /><DialogHost /><ToastHost /></>;
  return <Shell />;
}

function navigate(route) {
  if (S.route.value === route) return;
  if (dirtyScopes().length) {
    confirmDialog({ title: "Discard unsaved changes?", message: "You have unsaved changes. Leaving will discard them.", confirmLabel: "Discard", danger: true })
      .then((ok) => { if (ok) { discardAll(); S.route.value = route; S.sidebarOpen.value = false; } });
    return;
  }
  S.route.value = route;
  S.sidebarOpen.value = false;
}

function Shell() {
  const route = S.route.value;
  return (
    <div class="app-shell">
      <Topbar />
      <div class="layout">
        {S.sidebarOpen.value && <div class="scrim" onClick={() => (S.sidebarOpen.value = false)} />}
        <Sidebar route={route} />
        <main class="content"><Content route={route} /></main>
      </div>
      <SaveBar />
      <DialogHost />
      <ToastHost />
    </div>
  );
}

function Topbar() {
  return (
    <header class="topbar">
      <div class="row-tight">
        <IconBtn class="menu-btn" name="menu" label="Menu" onClick={() => (S.sidebarOpen.value = !S.sidebarOpen.value)} />
        <div class="brand"><span class="logo" />AeroAIRouter</div>
      </div>
      <div class="topbar-right">
        <BotPill />
        <Btn variant="secondary" size="sm" icon="restart" onClick={restartBot}>Restart bot</Btn>
        <OverflowMenu />
      </div>
    </header>
  );
}
function BotPill() {
  const s = S.botStatus.value;
  const cls = s === "active" ? "active" : (s === "failed" || s === "inactive") ? "failed" : "";
  return <span class={`bot-pill ${cls}`}><span class="dot" />bot: {s}</span>;
}
function OverflowMenu() {
  const [open, setOpen] = useState(false);
  const ref = useRef();
  useEffect(() => { const h = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); }; document.addEventListener("click", h); return () => document.removeEventListener("click", h); }, []);
  const item = (label, fn) => <button class="nav-item" onClick={() => { setOpen(false); fn(); }}>{label}</button>;
  const theme = S.theme.value;
  return (
    <div ref={ref} style="position:relative">
      <IconBtn name="cog" label="Menu" onClick={() => setOpen((o) => !o)} />
      {open && (
        <div class="card" style="position:absolute;right:0;top:42px;z-index:45;min-width:190px;padding:6px">
          <button class="nav-item" onClick={() => applyTheme(theme === "light" ? "dark" : "light")}>
            <Icon name={theme === "light" ? "moon" : "sun"} size={16} />{theme === "light" ? "Dark theme" : "Light theme"}
          </button>
          {item("Change password", changePassword)}
          {item("Log out", async () => { await api("POST", "/api/logout"); location.reload(); })}
        </div>
      )}
    </div>
  );
}

function Sidebar({ route }) {
  const schema = S.schema.value;
  const inGroup = (g) => schema.filter((s) => (s.group || "Setup") === g);
  const item = (id, title, icon, child) => (
    <button class={`nav-item ${route === id ? "active" : ""} ${child ? "child" : ""}`} onClick={() => navigate(id)}>
      {icon && <span class="nav-ico"><Icon name={icon} size={17} /></span>}{title}
    </button>
  );
  const onPlugins = route === "__plugins" || route.startsWith("__plugin:");
  return (
    <nav class={`sidebar ${S.sidebarOpen.value ? "open" : ""}`}>
      {item("__dash", "Dashboard", "dashboard")}
      <div class="nav-group">Setup</div>
      {inGroup("Setup").map((s) => item(s.id, s.title, SECTION_ICONS[s.id]))}
      <div class="nav-group">Extensions</div>
      {item("__plugins", "Plugins", "plugins")}
      {onPlugins && S.plugins.value.filter((p) => !p.uninstalled && ((p.configSchema || []).length || p.ui || p.hasCheckToken)).map((p) => item("__plugin:" + p.name, p.label || p.name, null, true))}
      {item("__mcp", "MCP Servers", "mcp")}
      <div class="nav-group">System</div>
      {inGroup("System").map((s) => item(s.id, s.title, SECTION_ICONS[s.id]))}
      {item("__raw", "Raw JSON", "raw")}
      <div class="nav-foot"><span>AeroAIRouter</span></div>
    </nav>
  );
}

function Content({ route }) {
  if (route === "__dash") return <Dashboard navigate={navigate} />;
  if (route === "__plugins") return <PluginsList navigate={navigate} />;
  if (route.startsWith("__plugin:")) return <PluginConfig name={route.slice("__plugin:".length)} navigate={navigate} />;
  if (route === "__mcp") return <McpView />;
  if (route === "__raw") return <RawJson />;
  const section = S.schema.value.find((s) => s.id === route);
  if (!section) return null;
  return <SettingsPage section={section} />;
}

function SettingsPage({ section }) {
  const hasAdvanced = section.fields.some((f) => f.advanced);
  return (
    <div>
      {hasAdvanced && (
        <div class="row" style="justify-content:flex-end;margin-bottom:-12px">
          <Switch size="sm" checked={S.advanced.value} onChange={(v) => (S.advanced.value = v)} label="Show advanced" />
        </div>
      )}
      <SchemaSection section={section} />
    </div>
  );
}

function SaveBar() {
  const scopes = dirtyScopes();
  if (!scopes.length) return null;
  const savers = S.savers.value;
  const msg = scopes.length === 1
    ? <>Unsaved changes in <b>{savers[scopes[0]].label}</b></>
    : <>Unsaved changes in <b>{scopes.length} areas</b></>;
  return (
    <div class="savebar">
      <span class="msg">{msg}</span>
      <div class="row-tight">
        <Btn variant="ghost" onClick={discardAll}>Discard</Btn>
        <Btn variant="primary" onClick={saveAll}>Save changes</Btn>
      </div>
    </div>
  );
}

boot().catch((ex) => { S.booting.value = false; toast("Failed to load: " + ex.message, "bad"); });
render(<App />, document.getElementById("app"));
