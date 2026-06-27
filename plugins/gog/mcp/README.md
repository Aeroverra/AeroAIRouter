# aero-gog-mcp

An MCP server (stdio) that wraps the [gogcli](https://github.com/openclaw/gogcli) (`gog`) binary to expose Gmail, Calendar, and Drive tools. Self-contained Node (built-ins only); it shells out to `gog`, which must be installed and authenticated.

## Tools

`gmail_search`, `gmail_read`, `gmail_send`, `calendar_events`, `drive_search`.

## Configuration (env vars)

| Variable | Required | Description |
| --- | --- | --- |
| `GOG_KEYRING_PASSWORD` | yes | Unlocks gog's file keyring (headless) |
| `GOG_BIN` | no | Path to the `gog` binary (default `gog` on PATH) |
| `GOG_ACCOUNT` | no | Account email/alias to act as (default account if unset) |

## Setup

Inside AeroAIRouter this is fully handled by the **Google (gogcli)** plugin's setup page (install, OAuth client, sign-in, enable). Standalone:

```bash
scripts/install-gogcli.sh                       # install the gog binary
gog auth credentials set client_secret.json     # your Desktop OAuth client
GOG_KEYRING_PASSWORD=secret gog auth add you@gmail.com --services gmail,calendar,drive
GOG_KEYRING_PASSWORD=secret GOG_ACCOUNT=you@gmail.com node index.js
```

gogcli covers many more Google services (Calendar, Drive, Docs, Sheets, Contacts, Tasks, …); this wrapper exposes a focused Gmail/Calendar/Drive subset — extend `TOOLS` in `index.js` to add more.
