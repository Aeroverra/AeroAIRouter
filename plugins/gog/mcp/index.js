#!/usr/bin/env node
// Standalone MCP server backed by the gogcli (`gog`) binary. Speaks MCP over
// stdio (newline-delimited JSON-RPC 2.0) and shells out to gog for Gmail,
// Calendar, and Drive. Self-contained (Node built-ins only); gog must be on the
// box (see scripts/install-gogcli.sh) and authenticated.
//
// Configuration (env vars only):
//   GOG_BIN                path to the gog binary (default "gog" on PATH)
//   GOG_ACCOUNT            account email/alias to act as (default account if unset)
//   GOG_KEYRING_PASSWORD   required to read gog's file keyring (headless)
import { spawn } from "child_process";

const BIN = process.env.GOG_BIN || "gog";
const ACCOUNT = process.env.GOG_ACCOUNT || "";

function runGog(args, { json = true, timeout = 60000 } = {}) {
  return new Promise((resolve) => {
    const full = [];
    if (json) full.push("--json");
    if (ACCOUNT) full.push("--account", ACCOUNT);
    full.push(...args);
    let out = "", err = "";
    let proc;
    try { proc = spawn(BIN, full, { env: { ...process.env } }); }
    catch (e) { return resolve({ code: 1, out: "", err: e.message }); }
    proc.stdout.on("data", (d) => (out += d));
    proc.stderr.on("data", (d) => (err += d));
    const t = setTimeout(() => proc.kill("SIGTERM"), timeout);
    proc.on("close", (code) => { clearTimeout(t); resolve({ code, out, err }); });
    proc.on("error", (e) => { clearTimeout(t); resolve({ code: 1, out: "", err: e.message }); });
  });
}

function clip(s, n = 12000) { return s.length > n ? s.slice(0, n) + "\n…[truncated]" : s; }
async function gog(args, opts) {
  const r = await runGog(args, opts);
  if (r.code !== 0) throw new Error((r.err || r.out || "gog exited " + r.code).trim().slice(0, 400));
  return clip((r.out || "").trim());
}

const TOOLS = [
  {
    name: "gmail_search",
    description: "Search Gmail with Gmail query syntax (e.g. 'from:bob is:unread newer_than:7d').",
    inputSchema: { type: "object", properties: { query: { type: "string" }, max: { type: "number", description: "Default 10." } }, required: ["query"] },
    run: (a) => gog(["gmail", "search", String(a.query || ""), "--max", String(Math.min(a.max || 10, 50))]),
  },
  {
    name: "gmail_read",
    description: "Read a Gmail message by id.",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    run: (a) => gog(["gmail", "get", String(a.id)]),
  },
  {
    name: "gmail_send",
    description: "Send an email.",
    inputSchema: {
      type: "object",
      properties: { to: { type: "string", description: "Comma-separated." }, subject: { type: "string" }, body: { type: "string" }, cc: { type: "string" }, bcc: { type: "string" } },
      required: ["to", "subject", "body"],
    },
    run: async (a) => {
      const args = ["gmail", "send", "--to", a.to, "--subject", a.subject, "--body", a.body];
      if (a.cc) args.push("--cc", a.cc);
      if (a.bcc) args.push("--bcc", a.bcc);
      const out = await gog(args, { json: false });
      return out || "Sent.";
    },
  },
  {
    name: "calendar_events",
    description: "List upcoming calendar events.",
    inputSchema: { type: "object", properties: { calendar: { type: "string", description: "Calendar id (default: all)." }, days: { type: "number", description: "Look ahead N days (default 7)." }, max: { type: "number" } }, required: [] },
    run: (a) => {
      const args = ["calendar", "events"];
      if (a.calendar) args.push(a.calendar);
      args.push("--days", String(a.days || 7), "--max", String(Math.min(a.max || 10, 50)));
      return gog(args);
    },
  },
  {
    name: "drive_search",
    description: "Full-text search across Google Drive.",
    inputSchema: { type: "object", properties: { query: { type: "string" }, max: { type: "number" } }, required: ["query"] },
    run: (a) => gog(["drive", "search", String(a.query || ""), "--max", String(Math.min(a.max || 20, 50))]),
  },
];

// ---- minimal MCP stdio runtime (newline-delimited JSON-RPC 2.0) ----
function send(msg) { process.stdout.write(JSON.stringify(msg) + "\n"); }
function ok(id, result) { send({ jsonrpc: "2.0", id, result }); }
function failR(id, code, message) { send({ jsonrpc: "2.0", id, error: { code, message } }); }

async function handle(line) {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  const { id, method, params } = msg;
  if (method === "initialize") return ok(id, { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "aero-gog-mcp", version: "1.0.0" } });
  if (method === "notifications/initialized") return;
  if (method === "ping") return ok(id, {});
  if (method === "tools/list") return ok(id, { tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) });
  if (method === "tools/call") {
    const t = TOOLS.find((x) => x.name === (params && params.name));
    if (!t) return ok(id, { isError: true, content: [{ type: "text", text: "unknown tool: " + (params && params.name) }] });
    try { const out = await t.run((params && params.arguments) || {}); return ok(id, { content: [{ type: "text", text: String(out) }] }); }
    catch (e) { return ok(id, { isError: true, content: [{ type: "text", text: e.message }] }); }
  }
  if (id !== undefined) failR(id, -32601, "method not found: " + method);
}

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (line) handle(line);
  }
});
process.stdin.on("end", () => process.exit(0));
