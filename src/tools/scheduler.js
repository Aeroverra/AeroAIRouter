import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { randomUUID } from "crypto";
import config from "../config/index.js";

const JOBS_FILE = join(config.dataDir, "cron-jobs.json");
let jobs = [];
const timers = new Map();
const running = new Set();

function load() {
  if (!existsSync(JOBS_FILE)) return;
  try {
    jobs = JSON.parse(readFileSync(JOBS_FILE, "utf8"));
  } catch {
    jobs = [];
  }
}

function save() {
  writeFileSync(JOBS_FILE, JSON.stringify(jobs, null, 2), "utf8");
}

function parseInterval(schedule) {
  const match = schedule.match(/^(\d+)(m|h|d)$/);
  if (!match) return null;
  const val = parseInt(match[1]);
  switch (match[2]) {
    case "m": return val * 60 * 1000;
    case "h": return val * 60 * 60 * 1000;
    case "d": return val * 24 * 60 * 60 * 1000;
  }
  return null;
}

async function fireJob(job) {
  if (running.has(job.id)) return;
  running.add(job.id);

  try {
    const { handleMessage } = await import("../ai/agent.js");
    const { getDiscordClient } = await import("../discord/client.js");
    const { default: config } = await import("../config/index.js");

    const client = getDiscordClient();
    if (!client) {
      console.log(`[cron] Discord not ready, skipping job ${job.name}`);
      return;
    }

    const channel = await client.channels.fetch(job.channelId).catch(() => null);
    if (!channel) {
      console.error(`[cron] Channel ${job.channelId} not found for job ${job.name}`);
      return;
    }

    console.log(`[cron] Firing job: ${job.name}`);

    const fakeAuthor = {
      id: config.discord.ownerId,
      displayName: "Scheduled Task",
      username: "cron",
    };

    const result = await handleMessage(job.task, config.discord.ownerId, channel, fakeAuthor, null);

    if (result?.trim()) {
      const chunks = [];
      let remaining = result;
      while (remaining.length > 0) {
        if (remaining.length <= 2000) { chunks.push(remaining); break; }
        let splitAt = remaining.lastIndexOf("\n", 2000);
        if (splitAt < 1000) splitAt = remaining.lastIndexOf(" ", 2000);
        if (splitAt < 1000) splitAt = 2000;
        chunks.push(remaining.substring(0, splitAt));
        remaining = remaining.substring(splitAt).trimStart();
      }
      for (const chunk of chunks) {
        await channel.send(chunk).catch(() => {});
      }
    }

    job.lastRunAt = new Date().toISOString();
    job.lastStatus = "ok";
    save();
  } catch (err) {
    console.error(`[cron] Job ${job.name} error:`, err.message);
    job.lastRunAt = new Date().toISOString();
    job.lastStatus = "error";
    job.lastError = err.message;
    save();
  } finally {
    running.delete(job.id);
  }
}

function scheduleJob(job) {
  if (timers.has(job.id)) {
    clearTimeout(timers.get(job.id));
    clearInterval(timers.get(job.id));
    timers.delete(job.id);
  }
  if (!job.enabled) return;

  if (job.type === "interval") {
    const ms = parseInterval(job.schedule);
    if (!ms) {
      console.error(`[cron] Invalid interval for job ${job.name}: ${job.schedule}`);
      return;
    }
    const timer = setInterval(() => fireJob(job), ms);
    timers.set(job.id, timer);
    console.log(`[cron] Scheduled interval job "${job.name}" every ${job.schedule}`);
  } else if (job.type === "once") {
    const targetMs = new Date(job.schedule).getTime();
    const delay = targetMs - Date.now();
    if (delay <= 0) {
      console.log(`[cron] One-shot job "${job.name}" already past due, firing now`);
      fireJob(job).then(() => deleteJob(job.id));
      return;
    }
    const timer = setTimeout(() => {
      fireJob(job).then(() => deleteJob(job.id));
    }, delay);
    timers.set(job.id, timer);
    console.log(`[cron] Scheduled one-shot job "${job.name}" at ${job.schedule}`);
  }
}

export function initScheduler() {
  load();
  for (const job of jobs) {
    scheduleJob(job);
  }
  console.log(`[cron] Initialized with ${jobs.length} job(s)`);
}

export function createJob(name, type, schedule, task, channelId) {
  const job = {
    id: randomUUID(),
    name,
    type,
    schedule,
    task,
    channelId,
    enabled: true,
    createdAt: new Date().toISOString(),
    lastRunAt: null,
    lastStatus: null,
  };
  jobs.push(job);
  save();
  scheduleJob(job);
  return { success: true, job: { id: job.id, name: job.name, type: job.type, schedule: job.schedule } };
}

export function listJobs() {
  return jobs.map((j) => ({
    id: j.id,
    name: j.name,
    type: j.type,
    schedule: j.schedule,
    task: j.task.length > 100 ? j.task.substring(0, 97) + "..." : j.task,
    channelId: j.channelId,
    enabled: j.enabled,
    createdAt: j.createdAt,
    lastRunAt: j.lastRunAt,
    lastStatus: j.lastStatus,
  }));
}

export function deleteJob(id) {
  const idx = jobs.findIndex((j) => j.id === id);
  if (idx === -1) return { success: false, error: "Job not found" };
  const name = jobs[idx].name;
  if (timers.has(id)) {
    clearTimeout(timers.get(id));
    clearInterval(timers.get(id));
    timers.delete(id);
  }
  jobs.splice(idx, 1);
  save();
  return { success: true, deleted: name };
}

export function toggleJob(id, enabled) {
  const job = jobs.find((j) => j.id === id);
  if (!job) return { success: false, error: "Job not found" };
  job.enabled = enabled;
  save();
  if (enabled) scheduleJob(job);
  else if (timers.has(id)) {
    clearTimeout(timers.get(id));
    clearInterval(timers.get(id));
    timers.delete(id);
  }
  return { success: true, name: job.name, enabled };
}

setImmediate(() => initScheduler());
