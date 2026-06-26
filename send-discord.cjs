const https = require("https");
const fs = require("fs");
const os = require("os");
const path = require("path");

// Resolve DISCORD_TOKEN from the environment, falling back to
// $AIROUTER_HOME/secrets.env (default ~/.aeroairouter/secrets.env).
// No secret is ever stored in this file.
function resolveDiscordToken() {
  if (process.env.DISCORD_TOKEN) return process.env.DISCORD_TOKEN;
  const home =
    (process.env.AIROUTER_HOME && process.env.AIROUTER_HOME.trim()) ||
    path.join(os.homedir(), ".aeroairouter");
  const secretsFile = path.join(home, "secrets.env");
  try {
    const raw = fs.readFileSync(secretsFile, "utf8");
    for (const line of raw.split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const body = t.startsWith("export ") ? t.slice(7).trim() : t;
      const eq = body.indexOf("=");
      if (eq === -1) continue;
      if (body.slice(0, eq).trim() !== "DISCORD_TOKEN") continue;
      let v = body.slice(eq + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      return v;
    }
  } catch {}
  return "";
}

const DISCORD_TOKEN = resolveDiscordToken();

const channelId = process.argv[2];
const message = process.argv[3];

if (!channelId || !message) {
  console.error("Usage: node send-discord.cjs <channel_id> <message>");
  process.exit(1);
}

if (!DISCORD_TOKEN) {
  console.error("DISCORD_TOKEN not set (env or $AIROUTER_HOME/secrets.env)");
  process.exit(1);
}

const data = JSON.stringify({ content: message });

const req = https.request({
  hostname: "discord.com",
  path: `/api/v10/channels/${channelId}/messages`,
  method: "POST",
  headers: {
    "Authorization": `Bot ${DISCORD_TOKEN}`,
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(data),
  },
}, (res) => {
  let body = "";
  res.on("data", (chunk) => body += chunk);
  res.on("end", () => {
    if (res.statusCode >= 200 && res.statusCode < 300) {
      console.log("Message sent");
    } else {
      console.error(`Discord API error ${res.statusCode}: ${body.substring(0, 200)}`);
      process.exit(1);
    }
  });
});

req.on("error", (err) => {
  console.error("Request error:", err.message);
  process.exit(1);
});

req.write(data);
req.end();
