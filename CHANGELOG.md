# Changelog

## Unreleased

### Plugins + MCP
- The bot is now an MCP client. Plugin and MCP tools register into the existing
  tool registry; they default to owner-only trust.
- Plugins gained a descriptor model: `meta`, `enabledByDefault`, `secrets`,
  `defaults`, `configSchema`, plus an optional `mcp(ctx)` that launches a bundled
  or external MCP server. `register(api)` still supported. Managed via
  `config.plugins.{enabled,disabled,config}` and a new **Plugins** UI tab.
- New bundled plugins **`github`** and **`cloudflare`** (on by default), each
  wrapping a self-contained, env-driven MCP server under `plugins/<name>/mcp/`
  that also runs standalone in any MCP client. Replaces the old `integrations`
  config section.
- New `config.mcp.servers` for user-added stdio MCP servers, with a **MCP** UI tab.
  Env values like `${SECRET}` resolve from `secrets.env` so tokens stay out of
  `config.json`.

## Open-source refactor
- Separated code from secrets/state: all config, secrets, persona, and runtime
  data now live in `AIROUTER_HOME` (default `~/.aeroairouter`), never in the repo.
- JSON config loader with validation and env/secrets.env precedence.
- Dual authentication: `ANTHROPIC_API_KEY` (default) or Claude subscription
  OAuth setup-token, selectable via `ai.auth.mode`.
- Plugin system: register tools and bash-command reviewers; `proxmox-review`
  extracted as a bundled plugin. Built-in danger-pattern safety floor.
- Voice made opt-in with configurable paths.
- Persona (soul/heartbeat/memory) templated; signature emoji is now config.
- Semantic guild/channel roles (`home`/`public`, `bot`/`general`).
- Optional self-update (git pull + reinstall + restart) on a schedule.
- Packaging: README, MIT license, install/update scripts, systemd template, examples.
