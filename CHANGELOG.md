# Changelog

## Unreleased

### Control panel rewrite
- The config UI was **rebuilt** on Preact + signals with a real design-token
  system and a component library (esbuild bundles `src/ui/client/` → committed
  `public/app.js` + `app.css`, so a plain clone/`git pull` needs no build step;
  strict CSP unchanged — no inline/CDN). Replaces the previous single 1500-line
  imperative script that full-re-rendered on every navigation.
- Unified save model: one sticky save bar for settings, plugin config, and MCP
  edits (the old mix of a global bar + per-card Save buttons is gone). Native
  `window.confirm`/`prompt` replaced by themed dialogs (incl. a proper
  change-password dialog); toasts now stack instead of overlapping.
- Light/dark themes, a responsive drawer sidebar, real toggle switches, keyboard
  focus rings, and `label`-associated fields. Restrained the pink accent to
  primary actions, focus, and the active nav item.
- New **Dashboard** landing page (bot status, channel/plugin/MCP-tool stats, live
  connection health, setup checklist) instead of dropping straight into settings;
  grouped sidebar navigation (Setup / Extensions / System).
- **Essentials** is broken into labelled subsections (Discord / Claude / Extras).
  Removed the redundant **AI** tab (its fields folded into Essentials → Claude,
  Advanced).
- Token checks (Cloudflare, GitHub) now render a structured breakdown —
  identity, permission/scope chips, and the accounts + domains the token can
  reach — instead of one comma-joined line.
- Plugins gained an **Uninstall** button (with confirmation; clears the plugin's
  config + stored credentials). Bundled plugins move to an "Available to
  reinstall" list and can be **reinstalled** anytime. Backed by
  `config.plugins.uninstalled`, `DELETE /api/plugins/:name`, and
  `POST /api/plugins/:name/reinstall`.
- **Voice** is now a bundled plugin (enable/configure under Plugins) rather than
  a top-level `features.voice` flag; the legacy flag still works as a fallback.

### gogcli (Google) plugin + UI setup
- New bundled **`gog`** plugin wrapping the [gogcli](https://github.com/openclaw/gogcli)
  `gog` binary: Gmail/Calendar/Drive tools through one sign-in. Idle until installed
  + authenticated.
- Fully **UI-driven setup** (no SSH): a custom Plugins panel installs the binary,
  saves the OAuth client, runs the headless `--remote` sign-in (link out → paste the
  redirect URL back), and enables the plugin. Backed by a generic plugin **actions**
  mechanism (`POST /api/plugins/:name/action/:action`) and `scripts/install-gogcli.sh`.

### Config cleanup
- Removed dead config: `discord.activity.type`, `integrations.github.tokens`, and the
  legacy `discord.guilds.home.id`. Dropped the unused `discord.elevatedUsers` UI field.
- Decluttered the Essentials tab (removed the legacy guild/channel fields); the
  still-used `discord.guilds.*` (voice, presence greetings, health/owner alerts) moved
  to Discord → advanced with clear "Legacy:" labels.

### Gmail plugin
- New bundled **`gmail`** plugin: a zero-dependency, fetch-based MCP server over
  the Gmail REST API (tools: search, read, send, list_labels, modify, whoami).
  Auth via Google OAuth (client id/secret + refresh token, projected as env).
  Enabled by default but stays idle until configured, so it never adds failing
  tools. `scripts/get-google-refresh-token.mjs` captures a refresh token via a
  local browser sign-in. A "Test connection" button reports the mailbox + counts.

### Config UI: plugin nav, multi-token, secret reveal
- Plugins tab now lists plugins (toggle + "Configure →"); configurable plugins
  expand into their own sub-tabs in the sidebar.
- Plugins can declare multiple scoped tokens (`tokens` config field). Each token
  has a **Check** button that reports the token's identity and scopes via the
  plugin's `checkToken()`. GitHub tools gain an optional `token_label` to pick a
  scoped credential per call; Cloudflare stores multiple and uses the primary.
- Any stored secret/credential (native or plugin) can be revealed in place by an
  authenticated admin (`POST /api/secrets/reveal`, allowed keys only).
- Access & URLs moved into the Network tab.

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
