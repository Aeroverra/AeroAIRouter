# aero-github-mcp

A small, standalone [Model Context Protocol](https://modelcontextprotocol.io) server for GitHub. It speaks MCP over stdio and is configured entirely through environment variables, so it works in **any** MCP client — it does not depend on AeroAIRouter.

## Tools

`create_repo`, `list_repos`, `get_repo`, `set_repo_visibility`, `create_issue`, `list_issues`, `whoami`.

## Configuration (env vars)

| Variable | Required | Description |
| --- | --- | --- |
| `GITHUB_TOKEN` | yes | Personal access token with `repo` scope |
| `GITHUB_DEFAULT_VISIBILITY` | no | `private` (default) or `public` — used when `create_repo` doesn't specify |

## Run it anywhere

Requires Node ≥ 20 (uses the built-in `fetch`). No `npm install` needed.

```bash
GITHUB_TOKEN=ghp_xxx node index.js
```

### In Claude Desktop / any MCP client

```json
{
  "mcpServers": {
    "github": {
      "command": "node",
      "args": ["/absolute/path/to/plugins/github/mcp/index.js"],
      "env": { "GITHUB_TOKEN": "ghp_xxx", "GITHUB_DEFAULT_VISIBILITY": "private" }
    }
  }
}
```

Inside AeroAIRouter you don't configure it here — the GitHub **plugin** projects your saved token into this server's env automatically. This folder is the same server, just launched for you.
