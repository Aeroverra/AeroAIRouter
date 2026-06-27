import { startDiscord, stopDiscord, getDiscordClient } from "./discord/client.js";
import { startWatching, stopWatching } from "./memory/loader.js";
import { setDiscordClient, scheduleWeeklyCheck } from "./tools/weekly-check.js";
import { setWatchdogClient, startWatchdog, stopWatchdog } from "./tools/watchdog.js";
import { loadCache, pruneCache } from "./tools/responded-cache.js";
import { pruneStaleHistory, handleMessage } from "./ai/agent.js";
import { bootCatchUp } from "./discord/bootup.js";
import { startVoiceMonitor, stopVoiceMonitor, setupVoiceAutoJoin } from "./discord/voice.js";
import { resumePersistedAgents } from "./discord/subagent.js";
import { loadPlugins } from "./plugins/loader.js";
import { startMcp } from "./mcp/client.js";
import { setUpdateClient, startSelfUpdate, stopSelfUpdate } from "./tools/self-update.js";
import { writeFileSync, readFileSync, existsSync, unlinkSync } from "fs";
import { join } from "path";
import config from "./config/index.js";
import { sleepSync } from "./util/sleep.js";

const PID_FILE = join(config.dataDir, "router.pid");

function acquirePidLock() {
  if (existsSync(PID_FILE)) {
    var oldPid = parseInt(readFileSync(PID_FILE, "utf8").trim(), 10);
    if (oldPid && !isNaN(oldPid) && oldPid !== process.pid) {
      try {
        process.kill(oldPid, 0);
        console.log("[azula] Killing stale instance PID " + oldPid);
        process.kill(oldPid, "SIGTERM");
        sleepSync(1000);
        try { process.kill(oldPid, 0); process.kill(oldPid, "SIGKILL"); } catch {}
      } catch {}
    }
  }
  writeFileSync(PID_FILE, String(process.pid), "utf8");
  console.log("[azula] PID lock acquired: " + process.pid);
}

function releasePidLock() {
  try {
    if (existsSync(PID_FILE)) {
      var stored = parseInt(readFileSync(PID_FILE, "utf8").trim(), 10);
      if (stored === process.pid) unlinkSync(PID_FILE);
    }
  } catch {}
}

let shuttingDown = false;
let pruneInterval = null;

async function start() {
  console.log("[azula] Starting up...");
  acquirePidLock();

  loadCache();
  startWatching();
  await loadPlugins();
  await startMcp(); // after plugins (so plugin MCP servers register) + before messages
  await startDiscord();

  const client = getDiscordClient();
  setDiscordClient(client);
  setWatchdogClient(client);

  scheduleWeeklyCheck();
  startWatchdog();
  setUpdateClient(client);
  startSelfUpdate();
  if (config.features && config.features.voice) {
    startVoiceMonitor();
    setupVoiceAutoJoin(client, handleMessage);
  } else {
    console.log("[azula] Voice disabled (set features.voice=true to enable)");
  }

  pruneInterval = setInterval(() => {
    pruneStaleHistory();
    pruneCache();
  }, 3600000);

  setTimeout(async () => {
    const { processMessage } = await import("./discord/client.js");
    await bootCatchUp(client, processMessage);
    await resumePersistedAgents(client);
  }, 5000);

  console.log("[azula] Online and ready");
}

async function shutdown(reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log("[azula] Shutting down: " + reason);
  if (pruneInterval) clearInterval(pruneInterval);
  stopWatchdog();
  stopSelfUpdate();
  stopVoiceMonitor();
  stopWatching();
  await stopDiscord();
  releasePidLock();
  process.exit(0);
}

async function restart() {
  console.log("[azula] Graceful restart requested");
  if (pruneInterval) clearInterval(pruneInterval);
  stopWatchdog();
  stopSelfUpdate();
  stopVoiceMonitor();
  stopWatching();
  await stopDiscord();
  shuttingDown = false;
  await start();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGHUP", () => restart());

process.on("uncaughtException", (err) => {
  console.error("[azula] Uncaught exception:", err);
});

process.on("unhandledRejection", (err) => {
  console.error("[azula] Unhandled rejection:", err);
});

start().catch((err) => {
  console.error("[azula] Fatal startup error:", err);
  process.exit(1);
});
