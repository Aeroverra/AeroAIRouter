#!/usr/bin/env node
// Standalone SMM-panels MCP server. Speaks MCP over stdio (newline-delimited
// JSON-RPC 2.0). Self-contained: only Node's built-in fetch. Wraps the standard
// SMM API v2 (POST form-data with key + action) for MoreThanPanel + JustAnotherPanel.
//
// Config (env only): MTP_URL/MTP_KEY, JAP_URL/JAP_KEY, SMM_DEFAULT (panel name).

const PANELS = {
  morethanpanel: { url: process.env.MTP_URL || "https://morethanpanel.com/api/v2", key: process.env.MTP_KEY || "" },
  justanotherpanel: { url: process.env.JAP_URL || "https://justanotherpanel.com/api/v2", key: process.env.JAP_KEY || "" },
};
const DEFAULT_PANEL = process.env.SMM_DEFAULT || "morethanpanel";

function panel(name) {
  const key = name || DEFAULT_PANEL;
  const p = PANELS[key];
  if (!p) throw new Error("Unknown panel '" + key + "' (use morethanpanel or justanotherpanel)");
  if (!p.key) throw new Error("Panel '" + key + "' has no API key configured");
  return p;
}
async function call(name, params) {
  const p = panel(name);
  const body = new URLSearchParams();
  body.set("key", p.key);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") body.set(k, String(v));
  const res = await fetch(p.url, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "aeroairouter-smm-mcp" }, body });
  const text = await res.text();
  let data; try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (data && data.error) throw new Error("SMM API error: " + data.error);
  if (!res.ok) throw new Error("HTTP " + res.status + ": " + String(text).slice(0, 200));
  return data;
}
const PANEL_PROP = { type: "string", enum: ["morethanpanel", "justanotherpanel"], description: "Which panel (default: the configured default)." };

const TOOLS = [
  {
    name: "balance",
    description: "Get the account balance on an SMM panel.",
    inputSchema: { type: "object", properties: { panel: PANEL_PROP } },
    run: async (a) => { const r = await call(a.panel, { action: "balance" }); return "Balance: " + r.balance + " " + (r.currency || ""); },
  },
  {
    name: "services",
    description: "List/search services on a panel (there are thousands — always pass `search`). Returns service id, name, category, rate per 1000, and min/max.",
    inputSchema: { type: "object", properties: { panel: PANEL_PROP, search: { type: "string", description: "Filter by words in the name/category (e.g. 'instagram comments')." }, limit: { type: "number", description: "Max results (default 30)." } } },
    run: async (a) => {
      const list = await call(a.panel, { action: "services" });
      if (!Array.isArray(list)) return "Unexpected response.";
      const q = (a.search || "").toLowerCase().split(/\s+/).filter(Boolean);
      const hit = (s) => q.every((w) => ((s.name || "") + " " + (s.category || "")).toLowerCase().includes(w));
      const rows = (q.length ? list.filter(hit) : list).slice(0, Math.min(a.limit || 30, 100));
      if (!rows.length) return "No services matched" + (a.search ? " '" + a.search + "'" : "") + ".";
      return rows.map((s) => s.service + " | " + s.name + " | " + s.category + " | rate " + s.rate + "/1k | " + s.min + "-" + s.max + (s.type && s.type !== "Default" ? " | type:" + s.type : "")).join("\n");
    },
  },
  {
    name: "order",
    description: "Place a REAL, PAID order on a panel — this spends money from the account balance. You MUST first check the service's rate (via `services`) and the balance, compute the cost (quantity/1000 * rate), and get the OWNER's explicit confirmation of that cost before calling this. Returns the order id — record it. For custom-comment services, pass `comments` (one per line).",
    inputSchema: {
      type: "object",
      properties: {
        panel: PANEL_PROP,
        service: { type: "number", description: "Service id (from `services`)." },
        link: { type: "string", description: "Target link (profile/post/etc.)." },
        quantity: { type: "number", description: "Quantity (omit for custom-comment services that count by lines)." },
        comments: { type: "string", description: "Custom comments, one per line (for comment services)." },
        runs: { type: "number", description: "Optional: split into N runs (drip-feed)." },
        interval: { type: "number", description: "Optional: minutes between runs." },
      },
      required: ["service", "link"],
    },
    run: async (a) => {
      const params = { action: "add", service: a.service, link: a.link };
      if (a.quantity) params.quantity = a.quantity;
      if (a.comments) params.comments = a.comments;
      if (a.runs) params.runs = a.runs;
      if (a.interval) params.interval = a.interval;
      const r = await call(a.panel, params);
      if (!r.order) throw new Error("No order id returned: " + JSON.stringify(r).slice(0, 200));
      return "Order placed on " + (a.panel || DEFAULT_PANEL) + " — order id " + r.order;
    },
  },
  {
    name: "status",
    description: "Check the status of one or more orders (charge, start count, status, remains).",
    inputSchema: { type: "object", properties: { panel: PANEL_PROP, order: { type: "string", description: "One order id, or several comma-separated." } }, required: ["order"] },
    run: async (a) => {
      const multi = String(a.order).includes(",");
      const r = await call(a.panel, multi ? { action: "status", orders: a.order } : { action: "status", order: a.order });
      return JSON.stringify(r, null, 2);
    },
  },
];

// ---- minimal MCP stdio runtime (newline-delimited JSON-RPC 2.0) ----
function send(msg) { process.stdout.write(JSON.stringify(msg) + "\n"); }
function ok(id, result) { send({ jsonrpc: "2.0", id, result }); }
function fail(id, code, message) { send({ jsonrpc: "2.0", id, error: { code, message } }); }

async function handle(line) {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  const { id, method, params } = msg;
  if (method === "initialize") return ok(id, { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "aero-smm-mcp", version: "1.0.0" } });
  if (method === "notifications/initialized") return;
  if (method === "ping") return ok(id, {});
  if (method === "tools/list") return ok(id, { tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) });
  if (method === "tools/call") {
    const t = TOOLS.find((x) => x.name === (params && params.name));
    if (!t) return ok(id, { isError: true, content: [{ type: "text", text: "unknown tool: " + (params && params.name) }] });
    try { const out = await t.run((params && params.arguments) || {}); return ok(id, { content: [{ type: "text", text: String(out) }] }); }
    catch (e) { return ok(id, { isError: true, content: [{ type: "text", text: e.message }] }); }
  }
  if (id !== undefined) fail(id, -32601, "method not found: " + method);
}

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\n")) !== -1) { const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (line) handle(line); } });
process.stdin.on("end", () => process.exit(0));
