#!/usr/bin/env node
// Standalone Gmail MCP server. Speaks MCP over stdio (newline-delimited
// JSON-RPC 2.0). Self-contained: depends only on Node's built-in fetch.
//
// Auth: Google OAuth (installed-app). Configure via env vars only:
//   GOOGLE_CLIENT_ID       required
//   GOOGLE_CLIENT_SECRET   required
//   GOOGLE_REFRESH_TOKEN   required (obtain once via scripts/get-google-refresh-token.mjs)
//   GMAIL_USER             optional — mailbox to act on (default "me")
//
// Scopes needed on the refresh token: gmail.modify + gmail.send.

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || "";
const REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN || "";
const USER = process.env.GMAIL_USER || "me";
const BASE = "https://gmail.googleapis.com/gmail/v1/users/" + encodeURIComponent(USER);

let _access = { token: "", exp: 0 };

async function accessToken() {
  if (!CLIENT_ID || !CLIENT_SECRET || !REFRESH_TOKEN) {
    throw new Error("Gmail not configured — set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN");
  }
  const now = Date.now();
  if (_access.token && now < _access.exp - 60000) return _access.token;
  const body = new URLSearchParams({
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    refresh_token: REFRESH_TOKEN,
    grant_type: "refresh_token",
  });
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.access_token) {
    throw new Error("Google token refresh failed: " + (d.error_description || d.error || ("HTTP " + r.status)));
  }
  _access = { token: d.access_token, exp: now + (d.expires_in || 3600) * 1000 };
  return _access.token;
}

async function api(path, method = "GET", body) {
  const token = await accessToken();
  const r = await fetch(BASE + path, {
    method,
    headers: { Authorization: "Bearer " + token, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let d;
  try { d = text ? JSON.parse(text) : {}; } catch { d = { raw: text }; }
  if (!r.ok) throw new Error("Gmail API " + r.status + ": " + String((d.error && d.error.message) || text).slice(0, 300));
  return d;
}

const b64urlDecode = (s) => Buffer.from(String(s || "").replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
const b64urlEncode = (s) => Buffer.from(s, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function header(headers, name) {
  const h = (headers || []).find((x) => x.name.toLowerCase() === name.toLowerCase());
  return h ? h.value : "";
}
function findBody(payload, mime) {
  if (!payload) return "";
  if (payload.mimeType === mime && payload.body && payload.body.data) return b64urlDecode(payload.body.data);
  for (const p of payload.parts || []) {
    const r = findBody(p, mime);
    if (r) return r;
  }
  return "";
}
function stripHtml(s) {
  return s.replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

const TOOLS = [
  {
    name: "search",
    description: "Search the mailbox with a Gmail query (e.g. 'from:bob is:unread newer_than:7d'). Returns matching messages.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string", description: "Gmail search query." }, max: { type: "number", description: "Max results (default 10, max 25)." } },
      required: ["query"],
    },
    run: async (a) => {
      const max = Math.min(a.max || 10, 25);
      const list = await api("/messages?maxResults=" + max + "&q=" + encodeURIComponent(a.query || ""));
      const ids = (list.messages || []).map((m) => m.id);
      if (!ids.length) return "(no messages)";
      const lines = [];
      for (const id of ids) {
        const m = await api("/messages/" + id + "?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date");
        const h = m.payload && m.payload.headers;
        lines.push(id + "  | " + header(h, "Date") + " | " + header(h, "From") + " | " + header(h, "Subject") + (m.snippet ? "\n    " + m.snippet : ""));
      }
      return lines.join("\n");
    },
  },
  {
    name: "read",
    description: "Read a full message by id (headers + plain-text body).",
    inputSchema: { type: "object", properties: { id: { type: "string" }, max_chars: { type: "number", description: "Truncate body (default 6000)." } }, required: ["id"] },
    run: async (a) => {
      const m = await api("/messages/" + a.id + "?format=full");
      const h = m.payload && m.payload.headers;
      let body = findBody(m.payload, "text/plain");
      if (!body) body = stripHtml(findBody(m.payload, "text/html"));
      const max = a.max_chars || 6000;
      if (body.length > max) body = body.slice(0, max) + "\n…[truncated]";
      return [
        "From: " + header(h, "From"),
        "To: " + header(h, "To"),
        "Date: " + header(h, "Date"),
        "Subject: " + header(h, "Subject"),
        "", body || "(no text body)",
      ].join("\n");
    },
  },
  {
    name: "send",
    description: "Send an email.",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string", description: "Recipient(s), comma-separated." },
        subject: { type: "string" },
        body: { type: "string", description: "Plain-text body." },
        cc: { type: "string" },
        bcc: { type: "string" },
      },
      required: ["to", "subject", "body"],
    },
    run: async (a) => {
      const lines = ["To: " + a.to];
      if (a.cc) lines.push("Cc: " + a.cc);
      if (a.bcc) lines.push("Bcc: " + a.bcc);
      lines.push("Subject: " + a.subject, "Content-Type: text/plain; charset=\"UTF-8\"", "MIME-Version: 1.0", "", a.body);
      const r = await api("/messages/send", "POST", { raw: b64urlEncode(lines.join("\r\n")) });
      return "Sent (message id " + r.id + ")";
    },
  },
  {
    name: "list_labels",
    description: "List the mailbox's labels.",
    inputSchema: { type: "object", properties: {} },
    run: async () => {
      const r = await api("/labels");
      return (r.labels || []).map((l) => l.name + "  (" + l.id + ")").join("\n") || "(none)";
    },
  },
  {
    name: "modify",
    description: "Modify a message: mark read/unread, archive, or add/remove labels.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        mark_read: { type: "boolean", description: "true = mark read, false = mark unread." },
        archive: { type: "boolean", description: "true = remove from Inbox." },
        add_labels: { type: "array", items: { type: "string" }, description: "Label IDs to add." },
        remove_labels: { type: "array", items: { type: "string" }, description: "Label IDs to remove." },
      },
      required: ["id"],
    },
    run: async (a) => {
      const add = Array.isArray(a.add_labels) ? a.add_labels.slice() : [];
      const remove = Array.isArray(a.remove_labels) ? a.remove_labels.slice() : [];
      if (a.mark_read === true) remove.push("UNREAD");
      if (a.mark_read === false) add.push("UNREAD");
      if (a.archive === true) remove.push("INBOX");
      await api("/messages/" + a.id + "/modify", "POST", { addLabelIds: add, removeLabelIds: remove });
      return "Modified " + a.id + (add.length ? " +[" + add.join(",") + "]" : "") + (remove.length ? " -[" + remove.join(",") + "]" : "");
    },
  },
  {
    name: "whoami",
    description: "Show the authenticated mailbox address and message/thread totals.",
    inputSchema: { type: "object", properties: {} },
    run: async () => {
      const p = await api("/profile");
      return p.emailAddress + "  (" + p.messagesTotal + " messages, " + p.threadsTotal + " threads)";
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
    return ok(id, { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "aero-gmail-mcp", version: "1.0.0" } });
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
