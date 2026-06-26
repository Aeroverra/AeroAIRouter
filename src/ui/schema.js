// Declarative schema driving the config UI forms. `path` is dot-notation into
// config.json; `secret` fields map to secrets.env keys instead. `advanced: true`
// hides the field unless Advanced mode is on. The raw-JSON editor covers anything
// not represented here, so everything remains configurable.
export const SECTIONS = [
  {
    id: "essentials",
    title: "Essentials",
    help: "The minimum to get the bot online.",
    fields: [
      { secret: "DISCORD_TOKEN", label: "Discord bot token", type: "secret", required: true, help: "From the Discord Developer Portal." },
      { path: "ai.auth.mode", label: "Claude auth mode", type: "select", options: ["auto", "apikey", "oauth"], help: "auto = API key if set, else OAuth." },
      { secret: "ANTHROPIC_API_KEY", label: "Anthropic API key", type: "secret", help: "Use this OR the OAuth token below." },
      { secret: "CLAUDE_CODE_OAUTH_TOKEN", label: "Claude OAuth setup-token", type: "secret", help: "From `claude setup-token` (subscription billing)." },
      { secret: "BRAVE_API_KEY", label: "Brave Search API key", type: "secret", help: "Optional — enables the web_search tool." },
      { path: "discord.ownerId", label: "Owner Discord user ID", type: "string", required: true, help: "Your Discord user ID (full trust)." },
      { path: "discord.guilds.home.id", label: "Primary server (guild) ID", type: "string" },
      { path: "discord.guilds.home.channels.bot", label: "Bot channel ID", type: "string", help: "Channel where the bot responds to everything." },
      { path: "ai.models.complex", label: "Model", type: "string", help: "e.g. claude-opus-4-8" },
      { path: "persona.emoji", label: "Signature emoji", type: "string", help: "Optional. e.g. a custom emoji markup; leave blank for none." },
    ],
  },
  {
    id: "discord",
    title: "Discord",
    help: "Channels, trust, and presence.",
    fields: [
      { path: "discord.channels", label: "Channels & response rules", type: "channels", help: "Pick the channels the bot watches. Per channel: respond to all messages or only when addressed, and whether to answer other bots." },
      { path: "ai.models.casual", label: "Casual model", type: "string", advanced: true },
      { path: "discord.wakeWord", label: "Wake word", type: "string", advanced: true, help: "Triggers a reply in general channels / voice (e.g. the bot's name)." },
      { path: "discord.elevatedUsers", label: "Elevated user IDs", type: "stringlist", advanced: true, help: "Extra tool access (no shell/file tools)." },
      { path: "discord.allowedBots", label: "Allowed bot IDs", type: "stringlist", advanced: true, help: "Bots the router is allowed to answer." },
      { path: "discord.people", label: "People (trust map)", type: "peoplemap", advanced: true, help: "userId -> name + trust (owner/elevated/light)." },
      { path: "discord.guilds.home.channels.general", label: "Home: general channel ID", type: "string", advanced: true },
      { path: "discord.guilds.public.id", label: "Public server (guild) ID", type: "string", advanced: true },
      { path: "discord.guilds.public.channels.bot", label: "Public: bot channel ID", type: "string", advanced: true },
      { path: "discord.guilds.public.channels.general", label: "Public: general channel ID", type: "string", advanced: true },
      { path: "discord.activity.text", label: "Presence text", type: "string", advanced: true },
      { path: "discord.activity.type", label: "Presence type (0-5)", type: "number", advanced: true },
      { path: "discord.activity.url", label: "Presence URL (for streaming)", type: "string", advanced: true },
      { path: "discord.presenceGreetings", label: "Presence greetings", type: "greetings", advanced: true, help: "Greet specific users on online / playing a game." },
    ],
  },
  {
    id: "ai",
    title: "AI",
    help: "Model + context tuning.",
    fields: [
      { path: "ai.accountUuid", label: "Account UUID (OAuth metadata)", type: "string", advanced: true },
      { path: "ai.maxTokens", label: "Max output tokens", type: "number", advanced: true },
      { path: "ai.maxHistoryPerChannel", label: "Max history per channel", type: "number", advanced: true },
    ],
  },
  {
    id: "persona",
    title: "Persona",
    help: "The bot's character & memory (markdown).",
    fields: [
      { persona: "soul.md", label: "soul.md — who the bot is", type: "markdown" },
      { persona: "heartbeat.md", label: "heartbeat.md — routing rules", type: "markdown", advanced: true },
      { persona: "memory.md", label: "memory.md — long-term memory", type: "markdown", advanced: true },
    ],
  },
  {
    id: "voice",
    title: "Voice",
    help: "Optional voice features (needs whisper + edge-tts).",
    fields: [
      { path: "features.voice", label: "Enable voice", type: "boolean" },
      { path: "voice.channelId", label: "Voice channel ID", type: "string", advanced: true },
      { path: "voice.whisperPath", label: "Whisper python path", type: "string", advanced: true },
      { path: "voice.edgeTtsPath", label: "edge-tts path", type: "string", advanced: true },
      { path: "voice.ttsCacheDir", label: "TTS cache dir", type: "string", advanced: true },
    ],
  },
  {
    id: "plugins",
    title: "Plugins",
    help: "Extend tools & command review.",
    fields: [
      { path: "plugins.enabled", label: "Enabled plugins", type: "stringlist" },
      { path: "plugins.config", label: "Plugin config (JSON)", type: "json", advanced: true },
    ],
  },
  {
    id: "review",
    title: "Command Review",
    help: "Safety policy for the bash tool.",
    fields: [
      { path: "review.policy", label: "Default policy", type: "select", options: ["allow", "deny"], help: "Verdict for non-dangerous commands with no reviewer." },
      { path: "review.allowReviewerOverride", label: "Let reviewers approve dangerous commands", type: "boolean" },
      { path: "review.dangerPatterns", label: "Danger patterns (regex)", type: "stringlist", advanced: true, help: "Leave empty to use built-in defaults." },
    ],
  },
  {
    id: "update",
    title: "Auto-Update",
    help: "Self-update from git.",
    fields: [
      { path: "update.enabled", label: "Enable auto-update", type: "boolean" },
      { path: "update.branch", label: "Branch", type: "string", advanced: true },
      { path: "update.intervalHours", label: "Check interval (hours)", type: "number", advanced: true },
      { path: "update.channelId", label: "Report to channel ID", type: "string", advanced: true },
    ],
  },
];
