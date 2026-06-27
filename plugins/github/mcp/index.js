#!/usr/bin/env node
// Standalone GitHub MCP server. Speaks MCP over stdio (newline-delimited
// JSON-RPC 2.0), so any MCP client can launch it. Self-contained: depends only
// on Node's built-in fetch — copy this folder anywhere and run it.
//
// Configuration (env vars only):
//   GITHUB_TOKEN               required — PAT with 'repo' scope (the default token)
//   GITHUB_TOKENS_JSON         optional — {"label": "token", ...} for multiple
//                              scoped tokens, selectable per call via token_label
//   GITHUB_DEFAULT_VISIBILITY  optional — "private" (default) or "public"

const TOKEN = process.env.GITHUB_TOKEN || "";
const DEFAULT_VIS = (process.env.GITHUB_DEFAULT_VISIBILITY || "private").toLowerCase();
const API = "https://api.github.com";

let TOKENS = {};
try { TOKENS = JSON.parse(process.env.GITHUB_TOKENS_JSON || "{}"); } catch { TOKENS = {}; }
const TOKEN_LABELS = Object.keys(TOKENS);

function pickToken(label) {
  if (label && TOKENS[label]) return TOKENS[label];
  return TOKEN || TOKENS[TOKEN_LABELS[0]] || "";
}

async function gh(path, method = "GET", body, label) {
  const token = pickToken(label);
  if (!token) throw new Error("No GitHub token configured" + (label ? " for label '" + label + "'" : ""));
  const res = await fetch(API + path, {
    method,
    headers: {
      Authorization: "Bearer " + token,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "aeroairouter-github-mcp",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!res.ok) throw new Error("GitHub API " + res.status + ": " + String(data.message || text).slice(0, 300));
  return data;
}

const TOOLS = [
  {
    name: "create_repo",
    description: "Create a new repository for the authenticated user.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Repository name" },
        description: { type: "string" },
        private: { type: "boolean", description: "Defaults to the configured default visibility." },
        auto_init: { type: "boolean", description: "Create an initial commit/README (default true)." },
      },
      required: ["name"],
    },
    run: async (a) => {
      const isPriv = typeof a.private === "boolean" ? a.private : DEFAULT_VIS !== "public";
      const r = await gh("/user/repos", "POST", { name: a.name, description: a.description || "", private: isPriv, auto_init: a.auto_init !== false }, a.token_label);
      return "Created " + r.full_name + " (" + (r.private ? "private" : "public") + ")\n" + r.html_url;
    },
  },
  {
    name: "list_repos",
    description: "List the authenticated user's repositories.",
    inputSchema: {
      type: "object",
      properties: {
        per_page: { type: "number", description: "Max results (default 30, max 100)." },
        sort: { type: "string", enum: ["created", "updated", "pushed", "full_name"] },
      },
    },
    run: async (a) => {
      const pp = Math.min(a.per_page || 30, 100);
      const r = await gh("/user/repos?per_page=" + pp + "&sort=" + (a.sort || "updated"), "GET", undefined, a.token_label);
      return r.map((x) => x.full_name + (x.private ? " (private)" : "")).join("\n") || "(no repositories)";
    },
  },
  {
    name: "get_repo",
    description: "Get details about a repository.",
    inputSchema: {
      type: "object",
      properties: { owner: { type: "string" }, repo: { type: "string" } },
      required: ["owner", "repo"],
    },
    run: async (a) => {
      const r = await gh("/repos/" + a.owner + "/" + a.repo, "GET", undefined, a.token_label);
      return JSON.stringify({ full_name: r.full_name, private: r.private, description: r.description, default_branch: r.default_branch, url: r.html_url, stars: r.stargazers_count, open_issues: r.open_issues_count }, null, 2);
    },
  },
  {
    name: "set_repo_visibility",
    description: "Change a repository's visibility (public or private).",
    inputSchema: {
      type: "object",
      properties: { owner: { type: "string" }, repo: { type: "string" }, private: { type: "boolean" } },
      required: ["owner", "repo", "private"],
    },
    run: async (a) => {
      const r = await gh("/repos/" + a.owner + "/" + a.repo, "PATCH", { private: !!a.private }, a.token_label);
      return r.full_name + " is now " + (r.private ? "private" : "public");
    },
  },
  {
    name: "create_issue",
    description: "Open an issue on a repository.",
    inputSchema: {
      type: "object",
      properties: { owner: { type: "string" }, repo: { type: "string" }, title: { type: "string" }, body: { type: "string" } },
      required: ["owner", "repo", "title"],
    },
    run: async (a) => {
      const r = await gh("/repos/" + a.owner + "/" + a.repo + "/issues", "POST", { title: a.title, body: a.body || "" }, a.token_label);
      return "Opened #" + r.number + ": " + r.html_url;
    },
  },
  {
    name: "list_issues",
    description: "List issues on a repository (excludes pull requests).",
    inputSchema: {
      type: "object",
      properties: { owner: { type: "string" }, repo: { type: "string" }, state: { type: "string", enum: ["open", "closed", "all"] } },
      required: ["owner", "repo"],
    },
    run: async (a) => {
      const r = await gh("/repos/" + a.owner + "/" + a.repo + "/issues?state=" + (a.state || "open") + "&per_page=50", "GET", undefined, a.token_label);
      return r.filter((i) => !i.pull_request).map((i) => "#" + i.number + " [" + i.state + "] " + i.title).join("\n") || "(no issues)";
    },
  },
  {
    name: "whoami",
    description: "Show the authenticated GitHub user.",
    inputSchema: { type: "object", properties: {} },
    run: async (a) => {
      const r = await gh("/user", "GET", undefined, a.token_label);
      return r.login + (r.name ? " (" + r.name + ")" : "");
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
    return ok(id, { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "aero-github-mcp", version: "1.0.0" } });
  }
  if (method === "notifications/initialized") return; // notification, no reply
  if (method === "ping") return ok(id, {});
  if (method === "tools/list") {
    // When more than one named token is configured, expose a token_label selector
    // so the model can pick a scoped credential per call.
    const multi = TOKEN_LABELS.length > 1;
    return ok(id, {
      tools: TOOLS.map((t) => {
        const schema = { type: "object", properties: { ...t.inputSchema.properties }, required: t.inputSchema.required };
        if (multi) {
          schema.properties.token_label = { type: "string", enum: TOKEN_LABELS, description: "Which configured token to use: " + TOKEN_LABELS.join(", ") + ". Defaults to the primary token." };
        }
        return { name: t.name, description: t.description, inputSchema: schema };
      }),
    });
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
