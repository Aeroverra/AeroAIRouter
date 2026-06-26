# Changelog

## Unreleased — open-source refactor
- Separated code from secrets/state: all config, secrets, persona, and runtime
  data now live in `AIROUTER_HOME` (default `~/.aeroairouter`), never in the repo.
- JSON config loader with validation and env/secrets.env precedence.
- Dual authentication: `ANTHROPIC_API_KEY` (default) or Claude subscription
  OAuth setup-token, selectable via `ai.auth.mode`.
- Plugin system: register tools and bash-command reviewers (see `plugins/example-plugin`). Built-in danger-pattern safety floor.
- Voice made opt-in with configurable paths.
- Persona (soul/heartbeat/memory) templated; signature emoji is now config.
- Semantic guild/channel roles (`home`/`public`, `bot`/`general`).
- Optional self-update (git pull + reinstall + restart) on a schedule.
- Packaging: README, MIT license, install/update scripts, systemd template, examples.
