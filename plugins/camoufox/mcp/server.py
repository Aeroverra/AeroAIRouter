#!/usr/bin/env python3
# Standalone Camoufox MCP server. Speaks MCP over stdio (newline-delimited
# JSON-RPC 2.0) — the same shape as the Node servers in this repo (github/mcp,
# cloudflare/mcp). Runs inside the camoufox venv the plugin's Install button
# creates (AIROUTER_HOME/camoufox-venv/bin/python). Launches a fresh Camoufox
# (anti-detect Firefox) per call and closes it after, so it uses no idle RAM.
#
# Config (env vars only):
#   CAMOUFOX_HEADLESS  "1" (default) / "0"
#   CAMOUFOX_WAIT_MS   ms to wait after load for JS/challenges (default 3500)
#   CAMOUFOX_MAXLEN    max chars of text to return (default 20000)
import os, sys, json, re

HEADLESS = os.environ.get("CAMOUFOX_HEADLESS", "1") != "0"
WAIT_MS = int(os.environ.get("CAMOUFOX_WAIT_MS", "3500") or 3500)
MAXLEN = int(os.environ.get("CAMOUFOX_MAXLEN", "20000") or 20000)


def clean_html(html):
    html = re.sub(r"(?is)<script[^>]*>.*?</script>", " ", html)
    html = re.sub(r"(?is)<style[^>]*>.*?</style>", " ", html)
    html = re.sub(r"(?s)<[^>]+>", " ", html)
    html = (html.replace("&nbsp;", " ").replace("&amp;", "&").replace("&lt;", "<")
            .replace("&gt;", ">").replace("&quot;", '"'))
    return re.sub(r"\s+", " ", html).strip()


def render(url, wait_ms=None, full_html=False, max_length=None):
    if not url or not isinstance(url, str):
        raise ValueError("url is required")
    from camoufox.sync_api import Camoufox
    wait = WAIT_MS if wait_ms is None else int(wait_ms)
    maxlen = MAXLEN if max_length is None else int(max_length)
    with Camoufox(headless=HEADLESS) as browser:
        page = browser.new_page()
        try:
            page.goto(url, wait_until="domcontentloaded", timeout=45000)
        except Exception:
            page.goto(url, timeout=45000)  # looser retry
        if wait > 0:
            page.wait_for_timeout(wait)
        html = page.content()
        try:
            title = page.title()
        except Exception:
            title = ""
        page.close()
    body = html if full_html else clean_html(html)
    truncated = maxlen and len(body) > maxlen
    if truncated:
        body = body[:maxlen]
    header = "URL: %s\nTITLE: %s%s\n\n" % (url, title, "  (truncated)" if truncated else "")
    return header + body


TOOLS = [
    {
        "name": "fetch_url",
        "description": (
            "Fetch a web page through Camoufox, an anti-detect stealth browser that runs "
            "JavaScript and bypasses most bot detection (Cloudflare 'Just a moment', "
            "'enable JavaScript', 403/429 walls, Turnstile). Use this whenever the normal "
            "web_fetch tool reports a page is anti-bot-blocked (blocked:true). Returns the "
            "rendered page text (or raw HTML if full_html)."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "url": {"type": "string", "description": "URL to fetch"},
                "wait_ms": {"type": "number", "description": "Extra ms to wait after load for challenges/JS to settle (default 3500)."},
                "full_html": {"type": "boolean", "description": "Return raw HTML instead of stripped text (default false)."},
                "max_length": {"type": "number", "description": "Max characters to return (default 20000)."},
            },
            "required": ["url"],
        },
        "run": lambda a: render(a.get("url"), a.get("wait_ms"), bool(a.get("full_html")), a.get("max_length")),
    },
]


# ---- minimal MCP stdio runtime (newline-delimited JSON-RPC 2.0) ----
def send(msg):
    sys.stdout.write(json.dumps(msg) + "\n")
    sys.stdout.flush()


def ok(mid, result):
    send({"jsonrpc": "2.0", "id": mid, "result": result})


def fail(mid, code, message):
    send({"jsonrpc": "2.0", "id": mid, "error": {"code": code, "message": message}})


def handle(line):
    try:
        msg = json.loads(line)
    except Exception:
        return
    mid = msg.get("id")
    method = msg.get("method")
    params = msg.get("params") or {}
    if method == "initialize":
        return ok(mid, {"protocolVersion": "2024-11-05", "capabilities": {"tools": {}},
                        "serverInfo": {"name": "aero-camoufox-mcp", "version": "1.0.0"}})
    if method == "notifications/initialized":
        return
    if method == "ping":
        return ok(mid, {})
    if method == "tools/list":
        return ok(mid, {"tools": [{"name": t["name"], "description": t["description"], "inputSchema": t["inputSchema"]} for t in TOOLS]})
    if method == "tools/call":
        name = params.get("name")
        t = next((x for x in TOOLS if x["name"] == name), None)
        if not t:
            return ok(mid, {"isError": True, "content": [{"type": "text", "text": "unknown tool: %s" % name}]})
        try:
            out = t["run"](params.get("arguments") or {})
            return ok(mid, {"content": [{"type": "text", "text": str(out)}]})
        except Exception as e:
            return ok(mid, {"isError": True, "content": [{"type": "text", "text": "camoufox error: %s" % e}]})
    if mid is not None:
        fail(mid, -32601, "method not found: %s" % method)


def main():
    for line in sys.stdin:
        line = line.strip()
        if line:
            handle(line)


if __name__ == "__main__":
    main()
