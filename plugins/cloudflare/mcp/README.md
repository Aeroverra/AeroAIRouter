# aero-cloudflare-mcp

A small, standalone [Model Context Protocol](https://modelcontextprotocol.io) server for Cloudflare. It speaks MCP over stdio and is configured entirely through environment variables, so it works in **any** MCP client — it does not depend on AeroAIRouter.

## Tools

`verify_token`, `list_zones`, `dns_list`, `dns_create`, `dns_update`, `dns_delete`.

## Configuration (env vars)

| Variable | Required | Description |
| --- | --- | --- |
| `CLOUDFLARE_TOKEN` | yes | API token with `Zone:Read` + `Zone:DNS:Edit` |
| `CLOUDFLARE_ACCOUNT_ID` | no | Default account for account-scoped calls |

## Run it anywhere

Requires Node ≥ 20 (uses the built-in `fetch`). No `npm install` needed.

```bash
CLOUDFLARE_TOKEN=cf_xxx node index.js
```

### In Claude Desktop / any MCP client

```json
{
  "mcpServers": {
    "cloudflare": {
      "command": "node",
      "args": ["/absolute/path/to/plugins/cloudflare/mcp/index.js"],
      "env": { "CLOUDFLARE_TOKEN": "cf_xxx" }
    }
  }
}
```

Inside AeroAIRouter you don't configure it here — the Cloudflare **plugin** projects your saved token into this server's env automatically.
