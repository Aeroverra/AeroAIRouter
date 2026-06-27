// MCP client. Connects to MCP servers (stdio) and exposes their tools to the
// model through the same tool registry the built-in tools use. Two sources:
//   - direct:  config.mcp.servers[]  (added/edited by the user via the UI)
//   - plugin:  registered by the plugin loader from a plugin's mcp() descriptor
//
// Plugin-provided servers are "managed": the UI shows them but can't toggle them
// (they live and die with their plugin). Direct servers are user-controlled.
//
// Tools are namespaced "<server>__<tool>" so two servers can expose the same
// tool name without colliding. Tool calls are forwarded to the server as
// MCP tools/call requests.
import { spawn } from "child_process";
import { writeFileSync } from "fs";
import { join } from "path";
import { registerTool } from "../tools/definitions.js";
import config from "../config/index.js";
import { DATA_DIR } from "../config/paths.js";

const STATUS_FILE = join(DATA_DIR, "mcp-status.json");
const PROTOCOL_VERSION = "2024-11-05";

// Anthropic tool names must match ^[a-zA-Z0-9_-]{1,64}$.
function sanitizeName(s) {
  return String(s).replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
}

// Resolve env values: a value of exactly "${VAR}" is replaced with process.env
// of that var, so users can keep secrets in secrets.env and reference them in a
// direct server's env map instead of pasting them into config.json.
function resolveEnv(envMap) {
  const out = {};
  for (const [k, v] of Object.entries(envMap || {})) {
    if (typeof v !== "string") continue;
    const m = v.match(/^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/);
    out[k] = m ? (process.env[m[1]] || "") : v;
  }
  return out;
}

// Newline-delimited JSON-RPC 2.0 over a child process's stdio.
class StdioConnection {
  constructor(spec) {
    this.spec = spec;
    this.proc = null;
    this.buf = "";
    this.nextId = 1;
    this.pending = new Map();
    this.dead = false;
  }
  start() {
    const env = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      ...resolveEnv(this.spec.env),
    };
    this.proc = spawn(this.spec.command, this.spec.args || [], {
      cwd: this.spec.cwd || undefined,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.proc.stdout.setEncoding("utf8");
    this.proc.stdout.on("data", (d) => this._onData(d));
    this.proc.stderr.setEncoding("utf8");
    this.proc.stderr.on("data", (d) => {
      const t = String(d).trim();
      if (t) console.error("[mcp:" + (this.spec.label || this.spec.command) + "] " + t.slice(0, 300));
    });
    this.proc.on("exit", (code) => this._fail(new Error("server exited (code " + code + ")")));
    this.proc.on("error", (err) => this._fail(err));
  }
  _onData(chunk) {
    this.buf += chunk;
    let idx;
    while ((idx = this.buf.indexOf("\n")) !== -1) {
      const line = this.buf.slice(0, idx).trim();
      this.buf = this.buf.slice(idx + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message || "MCP error"));
        else resolve(msg.result);
      }
    }
  }
  _fail(err) {
    this.dead = true;
    for (const { reject } of this.pending.values()) reject(err);
    this.pending.clear();
  }
  request(method, params, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      if (this.dead || !this.proc) return reject(new Error("not connected"));
      const id = this.nextId++;
      const timer = setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error("MCP timeout: " + method)); }
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params: params || {} }) + "\n");
    });
  }
  notify(method, params) {
    if (this.proc && !this.dead) {
      this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params: params || {} }) + "\n");
    }
  }
  stop() { try { this.proc && this.proc.kill("SIGTERM"); } catch {} }
}

// All known servers (both sources), for connect + UI status.
const servers = [];

// Called by the plugin loader for each plugin that declares an mcp() descriptor.
export function addPluginServer(pluginName, spec, opts = {}) {
  if (!spec || !spec.command) {
    console.error("[mcp] plugin " + pluginName + " returned an invalid mcp spec");
    return;
  }
  servers.push({
    name: pluginName,
    label: opts.label || pluginName,
    source: "plugin",
    plugin: pluginName,
    transport: spec.transport || "stdio",
    spec,
    enabled: true,
    managed: true,
    trust: spec.trust || opts.trust || "owner",
    status: "pending",
    error: null,
    tools: [],
  });
}

function loadDirectServers() {
  const list = config.mcp && Array.isArray(config.mcp.servers) ? config.mcp.servers : [];
  for (const s of list) {
    if (!s || !s.name) continue;
    servers.push({
      name: s.name,
      label: s.name,
      source: "direct",
      plugin: null,
      transport: s.transport || "stdio",
      spec: s,
      enabled: s.enabled !== false,
      managed: false,
      trust: s.trust || "owner",
      status: s.enabled === false ? "disabled" : "pending",
      error: null,
      tools: [],
    });
  }
}

function mcpResultToToolResult(r) {
  if (!r) return { success: true };
  const parts = (r.content || []).map((c) => (c && c.type === "text" ? c.text : JSON.stringify(c)));
  const text = parts.join("\n");
  if (r.isError) return { success: false, error: text || "tool error" };
  return { success: true, output: text };
}

async function connectServer(entry) {
  if (!entry.enabled) { entry.status = "disabled"; return; }
  if (entry.transport !== "stdio") {
    entry.status = "error";
    entry.error = "unsupported transport (only stdio for now): " + entry.transport;
    return;
  }
  const conn = new StdioConnection({ ...entry.spec, label: entry.label });
  entry.conn = conn;
  try {
    conn.start();
    await conn.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "aeroairouter", version: "1.0.0" },
    }, 15000);
    conn.notify("notifications/initialized", {});
    const res = await conn.request("tools/list", {}, 15000);
    const tools = (res && res.tools) || [];
    for (const t of tools) {
      const registeredName = sanitizeName(entry.name + "__" + t.name);
      registerTool(
        {
          name: registeredName,
          description: (t.description || t.name) + " [via the " + entry.label + " MCP server]",
          input_schema: t.inputSchema || { type: "object", properties: {} },
        },
        async (input) => {
          try {
            const r = await conn.request("tools/call", { name: t.name, arguments: input || {} }, 120000);
            return mcpResultToToolResult(r);
          } catch (err) {
            return { success: false, error: err.message };
          }
        },
        { trust: entry.trust }
      );
      entry.tools.push({ name: t.name, registeredName, description: t.description || "" });
    }
    entry.status = "connected";
    console.log("[mcp] " + entry.label + ": connected, " + tools.length + " tool(s)");
  } catch (err) {
    entry.status = "error";
    entry.error = err.message;
    conn.stop();
    console.error("[mcp] " + entry.label + ": " + err.message);
  }
}

function writeStatus() {
  try {
    const data = servers.map((s) => ({
      name: s.name,
      label: s.label,
      source: s.source,
      plugin: s.plugin,
      transport: s.transport,
      enabled: s.enabled,
      managed: s.managed,
      trust: s.trust,
      status: s.status,
      error: s.error,
      tools: s.tools.map((t) => ({ name: t.name, registeredName: t.registeredName, description: t.description })),
      updatedAt: new Date().toISOString(),
    }));
    writeFileSync(STATUS_FILE, JSON.stringify(data, null, 2), { encoding: "utf8", mode: 0o600 });
  } catch (err) {
    console.error("[mcp] failed to write status file: " + err.message);
  }
}

// Connect every enabled server. Called once at startup AFTER loadPlugins (so
// plugin-provided servers are registered) and BEFORE the bot handles messages
// (so tool schemas are stable for prompt caching).
export async function startMcp() {
  loadDirectServers();
  if (!servers.length) {
    console.log("[mcp] no servers configured");
    writeStatus();
    return;
  }
  for (const entry of servers) {
    await connectServer(entry);
  }
  const ok = servers.filter((s) => s.status === "connected").length;
  console.log("[mcp] " + ok + "/" + servers.length + " server(s) connected");
  writeStatus();
}

export function getMcpServers() {
  return servers;
}
