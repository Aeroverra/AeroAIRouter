#!/usr/bin/env node
// Standalone Cloudflare MCP server. Speaks MCP over stdio (newline-delimited
// JSON-RPC 2.0). Self-contained: depends only on Node's built-in fetch.
//
// Configuration (env vars only):
//   CLOUDFLARE_TOKEN       required — API token (Zone:Read + Zone:DNS:Edit)
//   CLOUDFLARE_ACCOUNT_ID  optional — default account for account-scoped calls

const TOKEN = process.env.CLOUDFLARE_TOKEN || "";
const API = "https://api.cloudflare.com/client/v4";

async function cf(path, method = "GET", body) {
  if (!TOKEN) throw new Error("CLOUDFLARE_TOKEN is not set");
  const res = await fetch(API + path, {
    method,
    headers: { Authorization: "Bearer " + TOKEN, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data;
  try { data = await res.json(); } catch { data = {}; }
  if (!res.ok || data.success === false) {
    const msg = (data.errors && data.errors.map((e) => e.message).join("; ")) || ("HTTP " + res.status);
    throw new Error("Cloudflare API: " + msg);
  }
  return data.result;
}

const TOOLS = [
  {
    name: "verify_token",
    description: "Verify the configured API token and show its status.",
    inputSchema: { type: "object", properties: {} },
    run: async () => {
      const r = await cf("/user/tokens/verify");
      return "Token status: " + r.status;
    },
  },
  {
    name: "list_zones",
    description: "List zones (domains) the token can access.",
    inputSchema: { type: "object", properties: { name: { type: "string", description: "Filter by domain name." } } },
    run: async (a) => {
      const q = a.name ? "?name=" + encodeURIComponent(a.name) : "";
      const r = await cf("/zones" + q);
      return r.map((z) => z.name + "  " + z.id + " [" + z.status + "]").join("\n") || "(no zones)";
    },
  },
  {
    name: "dns_list",
    description: "List DNS records in a zone.",
    inputSchema: {
      type: "object",
      properties: { zone_id: { type: "string" }, type: { type: "string", description: "Filter by record type (A, CNAME, TXT, ...)." } },
      required: ["zone_id"],
    },
    run: async (a) => {
      const q = a.type ? "?type=" + encodeURIComponent(a.type) + "&per_page=100" : "?per_page=100";
      const r = await cf("/zones/" + a.zone_id + "/dns_records" + q);
      return r.map((d) => d.type + " " + d.name + " -> " + d.content + (d.proxied ? " (proxied)" : "") + "  " + d.id).join("\n") || "(no records)";
    },
  },
  {
    name: "dns_create",
    description: "Create a DNS record in a zone.",
    inputSchema: {
      type: "object",
      properties: {
        zone_id: { type: "string" },
        type: { type: "string", description: "A, AAAA, CNAME, TXT, MX, ..." },
        name: { type: "string", description: "Record name (e.g. www.example.com or @)." },
        content: { type: "string", description: "Record value (IP, target, text...)." },
        ttl: { type: "number", description: "TTL seconds; 1 = automatic (default)." },
        proxied: { type: "boolean", description: "Route through Cloudflare's proxy (A/AAAA/CNAME)." },
      },
      required: ["zone_id", "type", "name", "content"],
    },
    run: async (a) => {
      const r = await cf("/zones/" + a.zone_id + "/dns_records", "POST", {
        type: a.type, name: a.name, content: a.content, ttl: a.ttl || 1, proxied: !!a.proxied,
      });
      return "Created " + r.type + " " + r.name + " -> " + r.content + "  (" + r.id + ")";
    },
  },
  {
    name: "dns_update",
    description: "Update an existing DNS record.",
    inputSchema: {
      type: "object",
      properties: {
        zone_id: { type: "string" }, record_id: { type: "string" },
        type: { type: "string" }, name: { type: "string" }, content: { type: "string" },
        ttl: { type: "number" }, proxied: { type: "boolean" },
      },
      required: ["zone_id", "record_id"],
    },
    run: async (a) => {
      const body = {};
      for (const k of ["type", "name", "content", "ttl", "proxied"]) if (a[k] !== undefined) body[k] = a[k];
      const r = await cf("/zones/" + a.zone_id + "/dns_records/" + a.record_id, "PATCH", body);
      return "Updated " + r.type + " " + r.name + " -> " + r.content;
    },
  },
  {
    name: "dns_delete",
    description: "Delete a DNS record.",
    inputSchema: {
      type: "object",
      properties: { zone_id: { type: "string" }, record_id: { type: "string" } },
      required: ["zone_id", "record_id"],
    },
    run: async (a) => {
      await cf("/zones/" + a.zone_id + "/dns_records/" + a.record_id, "DELETE");
      return "Deleted record " + a.record_id;
    },
  },
];

// ---- minimal MCP stdio runtime (newline-delimited JSON-RPC 2.0) ----
function send(msg) { process.stdout.write(JSON.stringify(msg) + "\n"); }
function ok(id, result) { send({ jsonrpc: "2.0", id, result }); }
function fail(id, code, message) { send({ jsonrpc: "2.0", id, error: { code, message } }); }

async function handle(line) {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  const { id, method, params } = msg;
  if (method === "initialize") {
    return ok(id, { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "aero-cloudflare-mcp", version: "1.0.0" } });
  }
  if (method === "notifications/initialized") return;
  if (method === "ping") return ok(id, {});
  if (method === "tools/list") {
    return ok(id, { tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) });
  }
  if (method === "tools/call") {
    const t = TOOLS.find((x) => x.name === (params && params.name));
    if (!t) return ok(id, { isError: true, content: [{ type: "text", text: "unknown tool: " + (params && params.name) }] });
    try {
      const out = await t.run((params && params.arguments) || {});
      return ok(id, { content: [{ type: "text", text: String(out) }] });
    } catch (e) {
      return ok(id, { isError: true, content: [{ type: "text", text: e.message }] });
    }
  }
  if (id !== undefined) fail(id, -32601, "method not found: " + method);
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
