// Bot-side task execution. Runs a task (from task-store) either as an AGENT
// (feeds the body to the model, which may or may not reply) or as a COMMAND (runs
// a shell command). Output is optional — a task may do its work silently (e.g. an
// OSRS xp checker that only posts on a gain). Only imported by the bot process
// (needs the Discord client + agent); the UI never imports this.
import { getTask, setTaskStatus, markTaskRunning, appendTaskLog } from "./task-store.js";
import config from "../config/index.js";

const running = new Set();

async function postToChannel(channelId, text) {
  if (!channelId || !text) return;
  const { getDiscordClient } = await import("../discord/client.js");
  const client = getDiscordClient(); if (!client) return;
  const channel = await client.channels.fetch(channelId).catch(() => null); if (!channel) return;
  let remaining = String(text);
  while (remaining.length > 0) {
    if (remaining.length <= 2000) { await channel.send(remaining).catch(() => {}); break; }
    let splitAt = remaining.lastIndexOf("\n", 2000);
    if (splitAt < 1000) splitAt = remaining.lastIndexOf(" ", 2000);
    if (splitAt < 1000) splitAt = 2000;
    await channel.send(remaining.slice(0, splitAt)).catch(() => {});
    remaining = remaining.slice(splitAt).trimStart();
  }
}

function runCommand(t) {
  return new Promise(async (resolve, reject) => {
    const { spawn } = await import("child_process");
    const chunks = [];
    const proc = spawn("/bin/bash", ["-c", t.body], { stdio: ["ignore", "pipe", "pipe"], detached: true });
    proc.stdout.on("data", (d) => { chunks.push(d); appendTaskLog(t.id, d.toString("utf8")); });
    proc.stderr.on("data", (d) => { chunks.push(d); appendTaskLog(t.id, d.toString("utf8")); });
    const killTimer = setTimeout(() => { try { process.kill(-proc.pid, "SIGKILL"); } catch { try { proc.kill("SIGKILL"); } catch {} } }, 10 * 60 * 1000);
    proc.on("close", async (code) => {
      clearTimeout(killTimer);
      const out = Buffer.concat(chunks).toString("utf8").trim();
      if (t.postOutput && t.channelId && out) await postToChannel(t.channelId, out);
      if (code && code !== 0) return reject(new Error("exit " + code + (out ? ": " + out.slice(-300) : "")));
      resolve(out || "(no output)");
    });
    proc.on("error", (e) => { clearTimeout(killTimer); reject(e); });
  });
}

async function runAgent(t) {
  const { handleMessage } = await import("../ai/agent.js");
  const { getDiscordClient } = await import("../discord/client.js");
  const client = getDiscordClient();
  if (!client) throw new Error("Discord client not ready");
  if (!t.channelId) throw new Error("Agent tasks need a channel");
  const channel = await client.channels.fetch(t.channelId).catch(() => null);
  if (!channel) throw new Error("Channel " + t.channelId + " not found");
  const fakeAuthor = { id: config.discord.ownerId, displayName: "Task: " + t.name, username: "task" };
  // handleMessage returns the reply text (does not auto-send). The task prompt can
  // instruct the model to return nothing when there's nothing to report.
  const result = await handleMessage(t.body, config.discord.ownerId, channel, fakeAuthor, null);
  const text = (result || "").trim();
  appendTaskLog(t.id, text || "(no message)");
  if (text && t.postOutput) await postToChannel(t.channelId, text);
  return text || "(no message)";
}

export async function runTask(id, opts = {}) {
  const t = getTask(id);
  if (!t) return { success: false, error: "Task not found" };
  if (running.has(id)) return { success: false, error: "Task already running" };
  running.add(id);
  markTaskRunning(id);
  console.log("[tasks] Running task \"" + t.name + "\" (" + t.type + ", " + (opts.source || "manual") + ")");
  try {
    const output = t.type === "command" ? await runCommand(t) : await runAgent(t);
    setTaskStatus(id, "ok", null, output);
    return { success: true, output };
  } catch (err) {
    console.error("[tasks] Task \"" + t.name + "\" failed: " + err.message);
    setTaskStatus(id, "error", err.message, null);
    return { success: false, error: err.message };
  } finally {
    running.delete(id);
  }
}
