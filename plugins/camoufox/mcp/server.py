#!/usr/bin/env python3
# Camoufox MCP server — full, PERSISTENT browser control (anti-detect Firefox via
# Playwright's surface). Speaks MCP over stdio (newline-delimited JSON-RPC 2.0).
# Runs inside the camoufox venv the plugin's Install button creates.
#
# One browser + a set of tabs are kept alive ACROSS tool calls (lazy-launched on the
# first navigate/interaction), so the model can navigate -> click -> fill -> evaluate
# as one real session. Everything is synchronous (Playwright sync API) — no asyncio.
# The browser stays open until `browser_close` or the process exits (bot restart);
# it uses ~200-400MB while open, so close it when done.
#
# Config (env vars): CAMOUFOX_HEADLESS ("1"/"0"), CAMOUFOX_WAIT_MS, CAMOUFOX_MAXLEN.
import os, sys, json, re, time

HEADLESS = os.environ.get("CAMOUFOX_HEADLESS", "1") != "0"
WAIT_MS = int(os.environ.get("CAMOUFOX_WAIT_MS", "3500") or 3500)
MAXLEN = int(os.environ.get("CAMOUFOX_MAXLEN", "20000") or 20000)

S = {"cm": None, "browser": None, "pages": [], "active": 0, "console": [], "network": []}


def clean_html(html):
    html = re.sub(r"(?is)<script[^>]*>.*?</script>", " ", html)
    html = re.sub(r"(?is)<style[^>]*>.*?</style>", " ", html)
    html = re.sub(r"(?s)<[^>]+>", " ", html)
    html = (html.replace("&nbsp;", " ").replace("&amp;", "&").replace("&lt;", "<")
            .replace("&gt;", ">").replace("&quot;", '"'))
    return re.sub(r"\s+", " ", html).strip()


def _wire(page):
    # Capture console + network into bounded ring buffers for the read tools.
    def on_console(msg):
        S["console"].append(str(getattr(msg, "type", "")) + ": " + str(getattr(msg, "text", "")))
        del S["console"][:-300]
    def on_request(req):
        try:
            S["network"].append(req.method + " " + req.url)
            del S["network"][:-300]
        except Exception:
            pass
    try:
        page.on("console", on_console)
        page.on("request", on_request)
    except Exception:
        pass
    return page


def ensure_page():
    if S["browser"] is None:
        from camoufox.sync_api import Camoufox
        cm = Camoufox(headless=HEADLESS)
        browser = cm.__enter__()
        S["cm"] = cm
        S["browser"] = browser
        S["pages"] = [_wire(browser.new_page())]
        S["active"] = 0
    if not S["pages"]:
        S["pages"] = [_wire(S["browser"].new_page())]
        S["active"] = 0
    S["active"] = max(0, min(S["active"], len(S["pages"]) - 1))
    return S["pages"][S["active"]]


def close_browser():
    if S["cm"] is not None:
        try:
            S["cm"].__exit__(None, None, None)
        except Exception:
            pass
    S["cm"] = None; S["browser"] = None; S["pages"] = []; S["active"] = 0
    S["console"] = []; S["network"] = []


def _text(page, full_html=False, maxlen=None):
    html = page.content()
    body = html if full_html else clean_html(html)
    ml = MAXLEN if maxlen is None else int(maxlen)
    trunc = ml and len(body) > ml
    if trunc:
        body = body[:ml]
    return body + ("\n\n…(truncated)" if trunc else "")


# ----------------------------------------------------------------- tools -----
def t_navigate(a):
    page = ensure_page()
    page.goto(a["url"], wait_until=a.get("wait_until", "domcontentloaded"), timeout=int(a.get("timeout_ms", 45000)))
    if a.get("wait_ms", WAIT_MS):
        page.wait_for_timeout(int(a.get("wait_ms", WAIT_MS)))
    return "Navigated to %s\nTITLE: %s" % (page.url, _safe(lambda: page.title(), ""))

def t_get_text(a):
    return _text(ensure_page(), bool(a.get("full_html")), a.get("max_length"))

def t_fetch_url(a):
    # One-shot: navigate + return rendered text. The anti-bot fallback web_fetch points at.
    page = ensure_page()
    page.goto(a["url"], wait_until="domcontentloaded", timeout=int(a.get("timeout_ms", 45000)))
    page.wait_for_timeout(int(a.get("wait_ms", WAIT_MS)))
    header = "URL: %s\nTITLE: %s\n\n" % (page.url, _safe(lambda: page.title(), ""))
    return header + _text(page, bool(a.get("full_html")), a.get("max_length"))

def t_current(a):
    page = ensure_page()
    return "URL: %s\nTITLE: %s" % (page.url, _safe(lambda: page.title(), ""))

def t_snapshot(a):
    page = ensure_page()
    snap = page.accessibility.snapshot()
    s = json.dumps(snap, ensure_ascii=False)
    return s[:MAXLEN] + ("…(truncated)" if len(s) > MAXLEN else "")

def t_screenshot(a):
    page = ensure_page()
    if a.get("wait_ms"):
        page.wait_for_timeout(int(a["wait_ms"]))
    path = "/tmp/camoufox-shot-%d.png" % int(time.time() * 1000)
    page.screenshot(path=path, full_page=bool(a.get("full_page")))
    return "Saved screenshot to %s (use view_image to see it)." % path

def t_click(a):
    ensure_page().click(a["selector"], timeout=int(a.get("timeout_ms", 15000)))
    return "clicked " + a["selector"]

def t_fill(a):
    ensure_page().fill(a["selector"], a.get("value", ""), timeout=int(a.get("timeout_ms", 15000)))
    return "filled " + a["selector"]

def t_type(a):
    ensure_page().type(a["selector"], a.get("text", ""), delay=int(a.get("delay_ms", 20)))
    return "typed into " + a["selector"]

def t_press(a):
    ensure_page().keyboard.press(a["key"])
    return "pressed " + a["key"]

def t_hover(a):
    ensure_page().hover(a["selector"], timeout=int(a.get("timeout_ms", 15000)))
    return "hovered " + a["selector"]

def t_select(a):
    ensure_page().select_option(a["selector"], a.get("value"))
    return "selected on " + a["selector"]

def t_wait_for(a):
    page = ensure_page()
    if a.get("selector"):
        page.wait_for_selector(a["selector"], timeout=int(a.get("timeout_ms", 30000)))
        return "found " + a["selector"]
    page.wait_for_timeout(int(a.get("ms", 1000)))
    return "waited %s ms" % a.get("ms", 1000)

def t_evaluate(a):
    page = ensure_page()
    result = page.evaluate(a["js"])
    try:
        return json.dumps(result, ensure_ascii=False)[:MAXLEN]
    except Exception:
        return str(result)[:MAXLEN]

def t_back(a):
    ensure_page().go_back()
    return "went back"

def t_console(a):
    return "\n".join(S["console"][-int(a.get("limit", 80)):]) or "(no console output)"

def t_network(a):
    return "\n".join(S["network"][-int(a.get("limit", 80)):]) or "(no requests captured)"

def t_new_tab(a):
    ensure_page()
    S["pages"].append(_wire(S["browser"].new_page()))
    S["active"] = len(S["pages"]) - 1
    if a.get("url"):
        S["pages"][S["active"]].goto(a["url"], timeout=45000)
    return "opened tab %d (%d total)" % (S["active"], len(S["pages"]))

def t_list_tabs(a):
    ensure_page()
    return "\n".join("%d%s %s" % (i, " *" if i == S["active"] else "", _safe(lambda: p.url, "?")) for i, p in enumerate(S["pages"]))

def t_switch_tab(a):
    ensure_page()
    S["active"] = max(0, min(int(a["index"]), len(S["pages"]) - 1))
    return "switched to tab %d" % S["active"]

def t_close_tab(a):
    i = int(a["index"])
    if 0 <= i < len(S["pages"]):
        try: S["pages"][i].close()
        except Exception: pass
        del S["pages"][i]
        S["active"] = min(S["active"], max(0, len(S["pages"]) - 1))
    return "closed tab %d (%d left)" % (i, len(S["pages"]))

def t_close(a):
    close_browser()
    return "browser closed"


def _safe(fn, default):
    try: return fn()
    except Exception: return default


TOOLS = [
    ("fetch_url", "Fetch a page through the stealth browser and return its rendered text — use this when the normal web_fetch is blocked by anti-bot protection (Cloudflare / JS challenge / 403). One-shot; for interactive control use navigate + the other tools.", {"type": "object", "properties": {"url": {"type": "string"}, "wait_ms": {"type": "number"}, "full_html": {"type": "boolean"}, "max_length": {"type": "number"}, "timeout_ms": {"type": "number"}}, "required": ["url"]}, t_fetch_url),
    ("navigate", "Open a URL in the persistent stealth browser (lazy-launches it). Args: url, wait_until?, wait_ms?, timeout_ms?.", {"type": "object", "properties": {"url": {"type": "string"}, "wait_until": {"type": "string", "enum": ["load", "domcontentloaded", "networkidle"]}, "wait_ms": {"type": "number"}, "timeout_ms": {"type": "number"}}, "required": ["url"]}, t_navigate),
    ("get_text", "Get the current page's rendered text (or full_html=true for raw HTML).", {"type": "object", "properties": {"full_html": {"type": "boolean"}, "max_length": {"type": "number"}}}, t_get_text),
    ("current", "Current page URL + title.", {"type": "object", "properties": {}}, t_current),
    ("snapshot", "Accessibility-tree snapshot of the page (roles/names) — good for finding elements to act on.", {"type": "object", "properties": {}}, t_snapshot),
    ("screenshot", "Screenshot the page to a PNG file on disk; returns the path (view_image it). full_page? wait_ms?.", {"type": "object", "properties": {"full_page": {"type": "boolean"}, "wait_ms": {"type": "number"}}}, t_screenshot),
    ("click", "Click an element by CSS/text selector.", {"type": "object", "properties": {"selector": {"type": "string"}, "timeout_ms": {"type": "number"}}, "required": ["selector"]}, t_click),
    ("fill", "Fill an input (clears then sets value).", {"type": "object", "properties": {"selector": {"type": "string"}, "value": {"type": "string"}, "timeout_ms": {"type": "number"}}, "required": ["selector"]}, t_fill),
    ("type", "Type text into an element key-by-key.", {"type": "object", "properties": {"selector": {"type": "string"}, "text": {"type": "string"}, "delay_ms": {"type": "number"}}, "required": ["selector", "text"]}, t_type),
    ("press_key", "Press a keyboard key (e.g. Enter, Tab, ArrowDown).", {"type": "object", "properties": {"key": {"type": "string"}}, "required": ["key"]}, t_press),
    ("hover", "Hover over an element.", {"type": "object", "properties": {"selector": {"type": "string"}, "timeout_ms": {"type": "number"}}, "required": ["selector"]}, t_hover),
    ("select_option", "Select an <option> by value/label in a <select>.", {"type": "object", "properties": {"selector": {"type": "string"}, "value": {"type": "string"}}, "required": ["selector"]}, t_select),
    ("wait_for", "Wait for a selector to appear, or a fixed number of ms.", {"type": "object", "properties": {"selector": {"type": "string"}, "ms": {"type": "number"}, "timeout_ms": {"type": "number"}}}, t_wait_for),
    ("evaluate", "Run arbitrary JavaScript in the page and return the JSON result. Powerful — use for scraping, clicking by JS, reading state.", {"type": "object", "properties": {"js": {"type": "string"}}, "required": ["js"]}, t_evaluate),
    ("go_back", "Navigate back in history.", {"type": "object", "properties": {}}, t_back),
    ("console_logs", "Recent browser console messages captured this session.", {"type": "object", "properties": {"limit": {"type": "number"}}}, t_console),
    ("network_requests", "Recent network requests captured this session.", {"type": "object", "properties": {"limit": {"type": "number"}}}, t_network),
    ("new_tab", "Open a new tab (optionally at a url) and make it active.", {"type": "object", "properties": {"url": {"type": "string"}}}, t_new_tab),
    ("list_tabs", "List open tabs (the active one is marked *).", {"type": "object", "properties": {}}, t_list_tabs),
    ("switch_tab", "Switch the active tab by index.", {"type": "object", "properties": {"index": {"type": "number"}}, "required": ["index"]}, t_switch_tab),
    ("close_tab", "Close a tab by index.", {"type": "object", "properties": {"index": {"type": "number"}}, "required": ["index"]}, t_close_tab),
    ("browser_close", "Close the whole browser session and free its memory. Do this when finished.", {"type": "object", "properties": {}}, t_close),
]
BY_NAME = {name: (desc, schema, fn) for (name, desc, schema, fn) in TOOLS}


# ---- minimal MCP stdio runtime (synchronous — Playwright sync API needs it) ----
def send(msg):
    sys.stdout.write(json.dumps(msg) + "\n"); sys.stdout.flush()

def handle(line):
    try: msg = json.loads(line)
    except Exception: return
    mid = msg.get("id"); method = msg.get("method"); params = msg.get("params") or {}
    if method == "initialize":
        return send({"jsonrpc": "2.0", "id": mid, "result": {"protocolVersion": "2024-11-05", "capabilities": {"tools": {}}, "serverInfo": {"name": "aero-camoufox-mcp", "version": "2.0.0"}}})
    if method == "notifications/initialized":
        return
    if method == "ping":
        return send({"jsonrpc": "2.0", "id": mid, "result": {}})
    if method == "tools/list":
        return send({"jsonrpc": "2.0", "id": mid, "result": {"tools": [{"name": n, "description": d, "inputSchema": s} for (n, d, s, _f) in TOOLS]}})
    if method == "tools/call":
        name = params.get("name"); entry = BY_NAME.get(name)
        if not entry:
            return send({"jsonrpc": "2.0", "id": mid, "result": {"isError": True, "content": [{"type": "text", "text": "unknown tool: %s" % name}]}})
        try:
            out = entry[2](params.get("arguments") or {})
            return send({"jsonrpc": "2.0", "id": mid, "result": {"content": [{"type": "text", "text": str(out)}]}})
        except Exception as e:
            return send({"jsonrpc": "2.0", "id": mid, "result": {"isError": True, "content": [{"type": "text", "text": "camoufox error: %s" % e}]}})
    if mid is not None:
        send({"jsonrpc": "2.0", "id": mid, "error": {"code": -32601, "message": "method not found: %s" % method}})


def main():
    try:
        for line in sys.stdin:
            line = line.strip()
            if line:
                handle(line)
    finally:
        close_browser()


if __name__ == "__main__":
    main()
