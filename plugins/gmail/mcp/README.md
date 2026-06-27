# aero-gmail-mcp

A small, standalone [Model Context Protocol](https://modelcontextprotocol.io) server for Gmail, over the Gmail REST API. Speaks MCP over stdio and is configured entirely through environment variables, so it works in **any** MCP client — it does not depend on AeroAIRouter. Zero dependencies (Node's built-in `fetch`).

## Tools

`search`, `read`, `send`, `list_labels`, `modify`, `whoami`.

## Configuration (env vars)

| Variable | Required | Description |
| --- | --- | --- |
| `GOOGLE_CLIENT_ID` | yes | OAuth client ID (Desktop app) |
| `GOOGLE_CLIENT_SECRET` | yes | OAuth client secret |
| `GOOGLE_REFRESH_TOKEN` | yes | Refresh token (see below) |
| `GMAIL_USER` | no | Mailbox to act on (default `me`) |

Scopes required on the refresh token: `gmail.modify` + `gmail.send`.

## One-time setup

1. **Google Cloud Console** → enable the **Gmail API**.
2. **OAuth consent screen**: External / Testing, and add your account under **Test users**.
3. **Credentials → Create OAuth client ID → Desktop app**. Note the client ID + secret.
4. Get a refresh token (run from the repo root):
   ```bash
   GOOGLE_CLIENT_ID=xxx GOOGLE_CLIENT_SECRET=yyy node scripts/get-google-refresh-token.mjs
   ```
   Open the printed URL, approve, and copy the `GOOGLE_REFRESH_TOKEN` it prints.

## Run it anywhere

Requires Node ≥ 20.

```bash
GOOGLE_CLIENT_ID=xxx GOOGLE_CLIENT_SECRET=yyy GOOGLE_REFRESH_TOKEN=zzz node index.js
```

Inside AeroAIRouter you don't run it directly — enable the **Gmail** plugin, paste the three values in its panel, and it launches this server with them. The server only activates once a refresh token is present.
