import { execFile } from "child_process";
import { join } from "path";
import config from "../config/index.js";
import { INSTALL_DIR } from "../config/paths.js";

let discordClient = null;
let timer = null;

export function setUpdateClient(client) {
  discordClient = client;
}

function runUpdateScript() {
  return new Promise((resolve) => {
    const script = join(INSTALL_DIR, "scripts", "update.sh");
    const branch = (config.update && config.update.branch) || "main";
    execFile(
      "/bin/bash",
      [script, branch],
      { cwd: INSTALL_DIR, timeout: 300000, encoding: "utf8" },
      (err, stdout, stderr) => {
        resolve({ ok: !err, stdout: stdout || "", stderr: stderr || (err ? err.message : "") });
      }
    );
  });
}

async function checkOnce() {
  const result = await runUpdateScript();
  const out = (result.stdout + "\n" + result.stderr).trim();
  // update.sh prints "ALREADY_UP_TO_DATE" or "UPDATED <oldsha>..<newsha>" on success.
  if (/ALREADY_UP_TO_DATE/.test(out)) {
    console.log("[update] up to date");
    return;
  }
  if (/UPDATED/.test(out)) {
    console.log("[update] applied update:\n" + out);
    if (discordClient && config.update && config.update.channelId) {
      const channel = await discordClient.channels.fetch(config.update.channelId).catch(() => null);
      if (channel) {
        await channel
          .send("Auto-update applied — restarting on the new version.\n```\n" + out.slice(0, 1500) + "\n```")
          .catch(() => {});
      }
    }
    // update.sh restarts the service itself; this process will be replaced.
    return;
  }
  console.error("[update] check failed:\n" + out.slice(0, 1000));
}

export function startSelfUpdate() {
  if (!(config.update && config.update.enabled)) {
    console.log("[update] auto-update disabled");
    return;
  }
  const hours = Math.max(1, Number(config.update.intervalHours) || 24);
  console.log("[update] auto-update enabled (branch " + (config.update.branch || "main") + ", every " + hours + "h)");
  // First check shortly after boot, then on the configured interval.
  setTimeout(checkOnce, 60000);
  timer = setInterval(checkOnce, hours * 3600 * 1000);
}

export function stopSelfUpdate() {
  if (timer) clearInterval(timer);
  timer = null;
}
