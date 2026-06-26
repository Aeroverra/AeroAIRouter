# AeroAIRouter

A self-hostable **Discord ↔ Claude router**: it listens in your Discord servers,
routes messages to a Claude model, and gives the model a real tool-belt (bash,
file read/write, web search/fetch, sub-agents, scheduled jobs, and optional
voice). Personality, memory, and access rules are all configuration you control.

- **Code and secrets are separated.** The install directory is just code. All
  secrets, config, persona, and runtime state live in `AIROUTER_HOME`
  (default `~/.aeroairouter/`) — nothing sensitive is ever in the repo.
- **Two auth options, both first-class.** Use a standard Anthropic API key, or a
  Claude subscription via an OAuth setup-token. Pick during setup.
- **Pluggable.** Add tools and bash-command safety reviewers via drop-in plugins.
- **Self-updating (optional).** Pull + reinstall + restart on a schedule.

## Requirements

- Node.js 20+
- A Discord bot token ([Discord Developer Portal](https://discord.com/developers/applications))
- A Claude credential: an `ANTHROPIC_API_KEY` **or** a Claude Code OAuth
  setup-token (`claude setup-token`)

## Install

```bash
git clone <your-fork-url> aeroairouter && cd aeroairouter
bash scripts/install.sh
```

`install.sh` installs dependencies and scaffolds `AIROUTER_HOME` from the
templates in `examples/` (without overwriting existing files). Then:

1. **`~/.aeroairouter/secrets.env`** — set `DISCORD_TOKEN` and either
   `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN`. (Optional: `BRAVE_API_KEY`
   to enable `web_search`.) This file is `chmod 600` and never committed.
2. **`~/.aeroairouter/config.json`** — set `discord.ownerId`, your guild/channel
   IDs, and the `people` trust map.
3. **`~/.aeroairouter/persona/*.md`** — optional: edit the bot's `soul`,
   `heartbeat` (routing rules), and `memory`.

Run it:

```bash
AIROUTER_HOME="$HOME/.aeroairouter" node src/index.js
```

Or install as a user service: copy `scripts/aeroairouter.service.template`,
replace `__INSTALL_DIR__`, `__NODE__`, and `__AIROUTER_HOME__`, drop it in
`~/.config/systemd/user/aeroairouter.service`, then
`systemctl --user enable --now aeroairouter.service`.

## Config UI

A web control panel manages everything in `config.json`, the secrets, and the
persona files — no hand-editing required.

```bash
npm run ui        # or install scripts/aeroairouter-ui.service.template as a service
```

- Binds `0.0.0.0`, so it's reachable on every LAN IP **and** your Tailscale IP;
  on startup it prints all the URLs (and advertises over mDNS if `bonjour-service`
  is installed).
- **Password-protected.** On first run it prints a one-time **setup code** to the
  console; the web wizard uses it to set your admin password and walk through the
  essentials (bot name, Discord token *with a live validity check*, owner ID,
  channels, Claude auth, model, emoji). You can re-run the wizard any time from
  the dashboard (it pre-fills current values).
- **Simple vs Advanced** mode, a per-section editor, a Discord **channel picker**
  (choose channels and set per-channel response rules), persona editors, and a
  raw-JSON editor so anything is configurable.
- Secret values are never sent to the browser (shown only as set/not-set) and are
  written to `secrets.env`, never to `config.json`.
- A **Restart bot** button applies changes (set `ui.serviceName` to your bot's
  systemd unit). Security: scrypt-hashed password, signed `sameSite=strict`
  session cookie, CSRF + same-origin checks, helmet headers, login rate-limiting.

UI settings live under `ui` in config.json: `{ port, host, serviceName, mdns }`.

## Authentication

Set the mode in `config.json` under `ai.auth.mode`:

- `"auto"` (default) — use `ANTHROPIC_API_KEY` if present, else the OAuth token.
- `"apikey"` — always use `ANTHROPIC_API_KEY`.
- `"oauth"` — always use the Claude subscription setup-token. The router replays
  the Claude Code CLI request headers so the call bills against your
  subscription. Generate the token with `claude setup-token`. (Note: this path
  depends on Claude Code CLI behavior and your account's terms — it's provided as
  an option, not the default.)

## Configuration reference (`config.json`)

| Key | Meaning |
|-----|---------|
| `discord.ownerId` | Your Discord user id (full owner trust). |
| `discord.elevatedUsers` | User ids with elevated tool access (no shell/file tools — owner only). |
| `discord.allowedBots` | Bot user ids the router is allowed to respond to (default: none). |
| `discord.wakeWord` | Word that triggers a reply in addressed channels / voice (e.g. the bot's name). |
| `discord.channels` | Per-channel rules: `[{ id, mode: "all"\|"addressed"\|"off", respondToBots }]`. Falls back to the guild channels if empty. |
| `discord.guilds.home` / `.public` | Two guild "roles" with `channels.bot` and `channels.general`. A single-server setup can point both at the same guild. |
| `discord.people` | Map of user id → `{ name, trust }` (`owner`/`elevated`/`light`). |
| `discord.activity` | Presence: `{ text, type, url }`. |
| `ai.auth.mode` | `auto` / `apikey` / `oauth`. |
| `ai.models` | `{ casual, complex }` model ids. |
| `persona.emoji` | Optional signature emoji injected into replies. |
| `features.voice` | Enable the voice feature (needs whisper + edge-tts). |
| `voice.*` | Voice channel id and paths to the whisper python + edge-tts. |
| `plugins.enabled` | List of plugin names to load. |
| `plugins.config` | Per-plugin config, keyed by plugin name. |
| `review.policy` | `allow` / `deny` — default verdict for non-dangerous commands when no reviewer opines. |
| `review.dangerPatterns` | Regex strings forming the safety floor (denied by default). |
| `review.allowReviewerOverride` | If `true`, a reviewer (e.g. Gemini) may approve a danger-matched command. Default `false` (danger patterns are a hard deny). |
| `update.*` | Auto-update: `{ enabled, branch, intervalHours, channelId }`. |

Secrets are **only** read from the environment / `secrets.env`, never from
`config.json`.

## Plugins

Enable by name in `config.plugins.enabled`. Plugins are resolved from
`AIROUTER_HOME/plugins/<name>/index.js` (user) or `./plugins/<name>/index.js`
(built-in). Each exports `register(api)`:

```js
export function register(api) {
  api.registerTool(schema, (input, ctx) => { /* ... */ });   // add a model tool
  api.registerCommandReviewer((command) => { /* ... */ });   // vet bash commands
  // api.config, api.log, api.pluginConfig(name), api.isDangerousCommand also available
}
```

See **`plugins/example-plugin/`** for a working template (registers a tool and a
command reviewer). A built-in safety floor (`review.dangerPatterns`) denies
destructive commands even when no plugin is loaded.

## Auto-update

Set `update.enabled: true` (and optionally `branch`, `intervalHours`,
`channelId`). On each interval the router runs `scripts/update.sh`, which
fast-forwards to `origin/<branch>`, reinstalls dependencies, and restarts the
service. It refuses to run on a dirty working tree. Requires the install dir to
be a git checkout.

## Security notes

- The `bash` tool gives the model shell access on the host. **Run the router
  under a dedicated, low-privilege user.** Prefer `review.policy: "deny"` if you
  don't need open-ended shell.
- The danger-pattern check is **best-effort defense-in-depth, not a sandbox.**
  By default danger-matched commands are a hard deny; setting
  `review.allowReviewerOverride: true` lets a reviewer plugin approve them.
- **Trust model:** only the owner gets `bash`, `read_file`, and `list_files`.
  Elevated users get the other tools; everyone else gets read/search tools only.
- **Auto-update trusts the configured git remote/branch** — it runs whatever is
  there (including npm lifecycle scripts). Only enable it on a remote you control.
- Voice and web search are off unless configured. Secrets live only in
  `secrets.env` (chmod 600) and are never written to `config.json` or logged.

## License

MIT — see [LICENSE](LICENSE).
