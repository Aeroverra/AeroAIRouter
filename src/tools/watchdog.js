import { emoji } from "../persona.js";
import { activeBackgroundTasks } from "../ai/agent.js";
import { getActiveAgents, sanitizeForDiscord } from "../discord/subagent.js";
import config from "../config/index.js";

let discordClient = null;
let watchdogInterval = null;
const alerted = new Set();

const STALL_THRESHOLD_MS = 10 * 60 * 1000;
const LONG_RUN_THRESHOLD_MS = 30 * 60 * 1000;

export function setWatchdogClient(client) {
  discordClient = client;
}

async function notifyOwner(message) {
  if (!discordClient) return;
  try {
    const channel = await discordClient.channels
      .fetch(config.discord.guilds.home.channels.bot)
      .catch(() => null);
    if (channel) {
      await channel.send(message).catch(console.error);
    }
  } catch {}
}

function checkBackgroundTasks() {
  const now = Date.now();
  const issues = [];

  for (const [channelId, tasks] of activeBackgroundTasks) {
    for (const [taskKey, meta] of tasks) {
      if (typeof meta === "string") continue;

      const sinceStart = now - meta.startedAt;
      const sinceActivity = now - meta.lastActivity;
      const alertKey = "bg-" + taskKey;

      if (sinceActivity > STALL_THRESHOLD_MS && !alerted.has(alertKey + "-stall")) {
        alerted.add(alertKey + "-stall");
        issues.push(
          "" + emoji() + " **Background task stalled** " + emoji() + "\n" +
          "Task: " + meta.summary + "\n" +
          "Channel: <#" + channelId + ">\n" +
          "Running for: " + Math.round(sinceStart / 60000) + " min\n" +
          "No activity for: " + Math.round(sinceActivity / 60000) + " min\n" +
          "This task may be stuck. I can kill it if needed."
        );
      } else if (sinceStart > LONG_RUN_THRESHOLD_MS && !alerted.has(alertKey + "-long")) {
        alerted.add(alertKey + "-long");
        issues.push(
          "" + emoji() + " **Background task running long** " + emoji() + "\n" +
          "Task: " + meta.summary + "\n" +
          "Channel: <#" + channelId + ">\n" +
          "Running for: " + Math.round(sinceStart / 60000) + " min\n" +
          "Still active (last tool call " + Math.round(sinceActivity / 60000) + " min ago)\n" +
          "Just a heads up. Let me know if you want me to stop it."
        );
      }
    }
  }

  return issues;
}

function checkSubagents() {
  const now = Date.now();
  const agents = getActiveAgents();
  const issues = [];

  for (const [agentId, agent] of agents) {
    if (agent.status !== "running") continue;

    const sinceStart = now - agent.startedAt;
    const sinceActivity = now - (agent.lastActivity || agent.startedAt);
    const alertKey = "agent-" + agentId;

    if (sinceActivity > STALL_THRESHOLD_MS && !alerted.has(alertKey + "-stall")) {
      alerted.add(alertKey + "-stall");
      issues.push(
        "" + emoji() + " **Sub-agent stalled** " + emoji() + "\n" +
        "Agent: `" + agentId + "`\n" +
        "Task: " + sanitizeForDiscord((agent.task || "unknown").substring(0, 100)) + "\n" +
        "Thread: <#" + agent.threadId + ">\n" +
        "Running for: " + Math.round(sinceStart / 60000) + " min\n" +
        "No activity for: " + Math.round(sinceActivity / 60000) + " min\n" +
        "This agent appears stuck. I can cancel it with `cancel_agent`."
      );
    } else if (sinceStart > LONG_RUN_THRESHOLD_MS && !alerted.has(alertKey + "-long")) {
      alerted.add(alertKey + "-long");
      issues.push(
        "" + emoji() + " **Sub-agent running long** " + emoji() + "\n" +
        "Agent: `" + agentId + "`\n" +
        "Task: " + sanitizeForDiscord((agent.task || "unknown").substring(0, 100)) + "\n" +
        "Thread: <#" + agent.threadId + ">\n" +
        "Running for: " + Math.round(sinceStart / 60000) + " min"
      );
    }
  }

  return issues;
}

async function runChecks() {
  const bgIssues = checkBackgroundTasks();
  const agentIssues = checkSubagents();
  const all = [...bgIssues, ...agentIssues];

  if (all.length === 0) return;

  console.log("[watchdog] Found " + all.length + " issue(s)");
  for (const issue of all) {
    await notifyOwner(issue);
  }
}

export function startWatchdog(intervalMs = 120000) {
  if (watchdogInterval) return;
  watchdogInterval = setInterval(runChecks, intervalMs);
  console.log("[watchdog] Active, checking every " + (intervalMs / 1000) + "s");
}

export function stopWatchdog() {
  if (watchdogInterval) {
    clearInterval(watchdogInterval);
    watchdogInterval = null;
  }
}
