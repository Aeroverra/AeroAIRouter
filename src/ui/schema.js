// Declarative schema driving the config UI forms. `path` is dot-notation into
// config.json; `secret` fields map to secrets.env keys instead. `advanced: true`
// hides the field unless Advanced mode is on. `group` (on a field) renders a
// labelled subsection within the page. `group` (on a section) groups it in the
// sidebar nav. The raw-JSON editor covers anything not represented here.
export const SECTIONS = [
  {
    id: "essentials",
    title: "Essentials",
    group: "Setup",
    help: "The minimum to get the bot online — Discord, Claude, and who's in charge.",
    fields: [
      { group: "Discord", path: "discord.ownerId", label: "Owner Discord user ID", type: "string", required: true, help: "Your Discord user ID (full trust). Enable Developer Mode in Discord, then right-click your name → Copy User ID." },
      { group: "Discord", secret: "DISCORD_TOKEN", label: "Discord bot token", type: "secret", required: true, help: "From the Discord Developer Portal → your app → Bot → Reset Token." },

      { group: "Claude", path: "ai.auth.mode", label: "Claude auth mode", type: "select", options: ["auto", "apikey", "oauth"], help: "auto = use the API key if set, otherwise the OAuth token." },
      { group: "Claude", secret: "ANTHROPIC_API_KEY", label: "Anthropic API key", type: "secret", help: "Use this OR the OAuth token below." },
      { group: "Claude", secret: "CLAUDE_CODE_OAUTH_TOKEN", label: "Claude OAuth setup-token", type: "secret", help: "From `claude setup-token` — bills to your Claude subscription." },
      { group: "Claude", path: "ai.models.complex", label: "Model", type: "string", help: "e.g. claude-opus-4-8" },
      { group: "Claude", path: "ai.models.casual", label: "Casual model", type: "string", advanced: true, help: "Cheaper model for lightweight replies. Defaults to the main model." },
      { group: "Claude", path: "ai.maxTokens", label: "Max output tokens", type: "number", advanced: true },
      { group: "Claude", path: "ai.maxHistoryPerChannel", label: "Max history per channel", type: "number", advanced: true },
      { group: "Claude", path: "ai.accountUuid", label: "Account UUID (OAuth metadata)", type: "string", advanced: true },

      { group: "Extras", secret: "BRAVE_API_KEY", label: "Brave Search API key", type: "secret", help: "Optional — enables the web_search tool." },
      { group: "Extras", path: "persona.emoji", label: "Signature emoji", type: "string", help: "Optional. Appended to messages; leave blank for none." },
    ],
  },
  {
    id: "claude",
    title: "Claude",
    group: "Setup",
    help: "Claude / LLM request settings. The request headers & params are structured as per-provider profiles so other LLMs can be added later.",
    fields: [
      { path: "ai.auth.mode", label: "Auth mode", type: "select", options: ["auto", "apikey", "oauth"], help: "auto = use the API key if set, otherwise the OAuth token." },
      { path: "ai.models.complex", label: "Model", type: "string", help: "e.g. claude-opus-4-8" },
      { path: "ai.maxTokens", label: "Max output tokens", type: "number", advanced: true },
      { path: "ai.providers.anthropic", label: "Request headers & params (Anthropic)", type: "llm", help: "Headers, query params, and the billing header sent with every Claude request. Edit / add / remove them; Restore defaults resets to what the bot ships with. (x-claude-code-session-id is added automatically per run.)" },
    ],
  },
  {
    id: "discord",
    title: "Discord",
    group: "Setup",
    help: "Channels the bot watches, who it trusts, and how it presents itself.",
    fields: [
      { path: "discord.channels", label: "Channels & response rules", type: "channels", help: "Pick the channels the bot watches. Per channel: a trigger mode (everything / name / @ or reply / off) that always governs you (the owner), plus toggles to also answer other people and other bots." },
      { path: "discord.wakeWord", label: "Wake word", type: "string", advanced: true, help: "Triggers a reply in general channels / voice (e.g. the bot's name)." },
      { path: "discord.allowedBots", label: "Allowed bot IDs", type: "stringlist", advanced: true, help: "Bots the router is allowed to answer." },
      { path: "discord.people", label: "People (trust map)", type: "peoplemap", advanced: true, help: "userId → name + trust (owner / elevated / light)." },
      { path: "discord.presenceGreetings", label: "Presence greetings", type: "greetings", advanced: true, help: "Greet specific users when they come online / start playing a game." },
      { group: "Presence", path: "discord.presence.status", label: "Status", type: "select", options: ["online", "idle", "dnd", "invisible"], help: "Online, idle, do-not-disturb, or invisible." },
      { group: "Presence", path: "discord.presence.activityType", label: "Activity type", type: "select", options: ["Playing", "Streaming", "Listening", "Watching"], help: "Bots can't set a true Custom Status, so the text shows as an activity line under the name." },
      { group: "Presence", path: "discord.presence.text", label: "Status text", type: "string", help: "e.g. zero-day in human form" },
      { group: "Presence", path: "discord.presence.url", label: "Stream URL", type: "string", help: "Streaming only — a twitch.tv / youtube.com URL makes it show the purple live badge." },
      { group: "Legacy guild roles", path: "discord.guilds.home.channels.bot", label: "Owner-alert channel ID", type: "string", advanced: true, help: "Legacy: where the watchdog posts owner alerts." },
      { group: "Legacy guild roles", path: "discord.guilds.public.id", label: "Voice/greetings server ID", type: "string", advanced: true, help: "Legacy: guild used for voice + presence greetings + the weekly health report." },
      { group: "Legacy guild roles", path: "discord.guilds.public.channels.bot", label: "Health-report channel ID", type: "string", advanced: true, help: "Legacy: weekly health check posts here." },
      { group: "Legacy guild roles", path: "discord.guilds.public.channels.general", label: "Greetings/voice channel ID", type: "string", advanced: true, help: "Legacy: presence greetings + voice join target." },
    ],
  },
  {
    id: "persona",
    title: "Persona",
    group: "Setup",
    help: "The bot's character & memory (markdown).",
    fields: [
      { persona: "soul.md", label: "soul.md — who the bot is", type: "markdown" },
      { persona: "heartbeat.md", label: "heartbeat.md — routing rules", type: "markdown", advanced: true },
      { persona: "memory.md", label: "memory.md — long-term memory", type: "markdown", advanced: true },
    ],
  },
  {
    id: "review",
    title: "Command Review",
    group: "System",
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
    group: "System",
    help: "Self-update from git.",
    fields: [
      { path: "update.enabled", label: "Enable auto-update", type: "boolean" },
      { path: "update.branch", label: "Branch", type: "string", advanced: true },
      { path: "update.intervalHours", label: "Check interval (hours)", type: "number", advanced: true },
      { path: "update.channelId", label: "Report to channel ID", type: "string", advanced: true },
    ],
  },
  {
    id: "network",
    title: "Network",
    group: "System",
    help: "Where the config UI listens, plus the URLs it's reachable at. Changing these requires a UI restart.",
    fields: [
      { path: "ui.hosts", label: "Listen addresses", type: "binds", help: "Bind to one or more addresses. 0.0.0.0 = all interfaces (LAN + Tailscale). Click a suggestion to add it." },
      { path: "ui.port", label: "Port", type: "number" },
      { path: "ui.mdns", label: "Advertise on the network (mDNS / .local)", type: "boolean" },
      { path: "ui.serviceName", label: "Bot systemd service (for the Restart-bot button)", type: "string", advanced: true },
      { path: "ui.selfService", label: "UI systemd service (for applying network changes)", type: "string", advanced: true },
    ],
  },
];
