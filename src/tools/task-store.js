// Shared, side-effect-free data layer for Tasks and Schedules. Both the bot
// (tasks.js / scheduler.js / the task bot-tool) and the config-UI server import
// this to CRUD the same JSON files — that's the IPC. The bot ALSO executes tasks
// (see tasks.js) and runs the cron engine (scheduler.js); the UI only does CRUD +
// enqueues "run now" requests here. No Discord/agent imports live in this module.
import { readFileSync, writeFileSync, existsSync, appendFileSync, mkdirSync } from "fs";
import { join } from "path";
import { randomUUID } from "crypto";
// Use the pure paths module (no side effects) so the config-UI server can import
// this without pulling in config/index.js's validation/logging.
import { DATA_DIR } from "../config/paths.js";

const TASKS_FILE = join(DATA_DIR, "tasks.json");
const SCHEDULES_FILE = join(DATA_DIR, "schedules.json");
const RUNQ_FILE = join(DATA_DIR, "run-queue.json");
const TASKLOG_DIR = join(DATA_DIR, "task-logs");

function readJson(file, fallback) {
  if (!existsSync(file)) return fallback;
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { return fallback; }
}
function writeJson(file, val) {
  try { writeFileSync(file, JSON.stringify(val, null, 2), "utf8"); } catch (e) { console.error("[tasks] write failed " + file + ": " + e.message); }
}
const nowIso = () => new Date().toISOString();

// ---------------------------------------------------------------- Tasks ------
// task = { id, name, description, type: "agent"|"command", body, channelId,
//          postOutput, createdAt, updatedAt, lastRunAt, lastStatus, lastError,
//          lastOutput }
export function readTasks() { const t = readJson(TASKS_FILE, []); return Array.isArray(t) ? t : []; }
export function writeTasks(tasks) { writeJson(TASKS_FILE, tasks); }
export function getTask(id) { return readTasks().find((t) => t.id === id) || null; }

export function taskSummary(t) {
  return {
    id: t.id, name: t.name, description: t.description || "", type: t.type,
    body: t.body || "", channelId: t.channelId || "", postOutput: t.postOutput !== false,
    createdAt: t.createdAt, lastRunAt: t.lastRunAt || null, lastFinishedAt: t.lastFinishedAt || null,
    lastStatus: t.lastStatus || null, lastError: t.lastError || null, lastOutput: (t.lastOutput || "").slice(0, 600),
  };
}
export function listTasks() { return readTasks().map(taskSummary); }

export function createTask(input) {
  const tasks = readTasks();
  const task = {
    id: randomUUID(), name: input.name || "Untitled task", description: input.description || "",
    type: input.type === "command" ? "command" : "agent", body: input.body || "",
    channelId: input.channelId || "", postOutput: input.postOutput !== false,
    createdAt: nowIso(), updatedAt: nowIso(), lastRunAt: null, lastStatus: null, lastError: null, lastOutput: "",
  };
  tasks.push(task); writeTasks(tasks); return task;
}
export function updateTask(id, patch) {
  const tasks = readTasks(); const t = tasks.find((x) => x.id === id); if (!t) return null;
  for (const k of ["name", "description", "type", "body", "channelId", "postOutput"]) if (k in patch) t[k] = patch[k];
  t.type = t.type === "command" ? "command" : "agent";
  t.updatedAt = nowIso(); writeTasks(tasks); return t;
}
export function deleteTask(id) {
  const tasks = readTasks(); const i = tasks.findIndex((x) => x.id === id); if (i < 0) return false;
  tasks.splice(i, 1); writeTasks(tasks);
  // also drop schedules that referenced it
  const scheds = readSchedules().filter((s) => s.taskId !== id); writeSchedules(scheds);
  return true;
}
export function duplicateTask(id) {
  const tasks = readTasks(); const t = tasks.find((x) => x.id === id); if (!t) return null;
  const copy = { ...t, id: randomUUID(), name: t.name + " (copy)", createdAt: nowIso(), updatedAt: nowIso(), lastRunAt: null, lastStatus: null, lastError: null, lastOutput: "" };
  tasks.push(copy); writeTasks(tasks); return copy;
}
// Mark a task as started: status "running", stamp the start time, clear the prior
// error, and truncate its live log. The UI (separate process) reads this from
// tasks.json to show "running now" and streams the log via readTaskLog.
export function markTaskRunning(id) {
  const tasks = readTasks(); const t = tasks.find((x) => x.id === id); if (!t) return;
  t.lastStatus = "running"; t.lastRunAt = nowIso(); t.lastError = null; writeTasks(tasks);
  truncateTaskLog(id);
}
// Merge final run status without clobbering concurrent edits (re-reads first).
// lastRunAt is left as the START time set by markTaskRunning.
export function setTaskStatus(id, status, error, output) {
  const tasks = readTasks(); const t = tasks.find((x) => x.id === id); if (!t) return;
  t.lastStatus = status; t.lastError = error || null; t.lastFinishedAt = nowIso();
  if (output != null) t.lastOutput = String(output).slice(0, 4000);
  writeTasks(tasks);
}
// Clear stale "running" flags left by a bot that died mid-task (called at boot).
export function resetRunningTasks() {
  const tasks = readTasks(); let changed = false;
  for (const t of tasks) if (t.lastStatus === "running") { t.lastStatus = "error"; t.lastError = "Interrupted (bot restarted)"; changed = true; }
  if (changed) writeTasks(tasks);
}

// --------------------------------------------------------- per-task logs -----
// A task's live/last-run output streams to data/task-logs/<id>.log so the UI can
// tail it while the task runs (command stdout+stderr) or read it afterward.
function taskLogPath(id) { return join(TASKLOG_DIR, id + ".log"); }
export function truncateTaskLog(id) {
  try { mkdirSync(TASKLOG_DIR, { recursive: true }); writeFileSync(taskLogPath(id), "", "utf8"); } catch { /* ignore */ }
}
export function appendTaskLog(id, str) {
  if (!str) return;
  try { mkdirSync(TASKLOG_DIR, { recursive: true }); appendFileSync(taskLogPath(id), str); } catch { /* ignore */ }
}
export function readTaskLog(id, maxBytes = 40000) {
  try {
    const p = taskLogPath(id); if (!existsSync(p)) return "";
    const buf = readFileSync(p);
    return buf.length > maxBytes ? "…(earlier output truncated)…\n" + buf.slice(buf.length - maxBytes).toString("utf8") : buf.toString("utf8");
  } catch { return ""; }
}

// ------------------------------------------------------------ Schedules ------
// schedule = { id, taskId, kind: "recurring"|"once", cron (UTC 5-field, recurring),
//              runAt (ISO UTC, once), enabled, createdAt, lastRunAt, lastStatus,
//              lastError, completedAt (once, set when it fires) }
export function readSchedules() { const s = readJson(SCHEDULES_FILE, []); return Array.isArray(s) ? s : []; }
export function writeSchedules(scheds) { writeJson(SCHEDULES_FILE, scheds); }

export function scheduleSummary(s, tasksById) {
  const task = tasksById ? tasksById[s.taskId] : null;
  return {
    id: s.id, taskId: s.taskId, taskName: task ? task.name : "(missing task)",
    kind: s.kind, cron: s.cron || "", runAt: s.runAt || "", enabled: s.enabled !== false,
    createdAt: s.createdAt, lastRunAt: s.lastRunAt || null, lastStatus: s.lastStatus || null,
    lastError: s.lastError || null, completedAt: s.completedAt || null,
  };
}
export function listSchedules() {
  const byId = {}; for (const t of readTasks()) byId[t.id] = t;
  return readSchedules().map((s) => scheduleSummary(s, byId));
}
export function createSchedule(input) {
  const scheds = readSchedules();
  const s = {
    id: randomUUID(), taskId: input.taskId, kind: input.kind === "once" ? "once" : "recurring",
    cron: input.cron || "", runAt: input.runAt || "", enabled: input.enabled !== false,
    createdAt: nowIso(), lastRunAt: null, lastStatus: null, lastError: null, completedAt: null,
  };
  scheds.push(s); writeSchedules(scheds); return s;
}
export function updateSchedule(id, patch) {
  const scheds = readSchedules(); const s = scheds.find((x) => x.id === id); if (!s) return null;
  for (const k of ["taskId", "kind", "cron", "runAt", "enabled"]) if (k in patch) s[k] = patch[k];
  if (patch.reset) { s.completedAt = null; s.lastStatus = null; s.lastError = null; }
  writeSchedules(scheds); return s;
}
export function deleteSchedule(id) {
  const scheds = readSchedules(); const i = scheds.findIndex((x) => x.id === id); if (i < 0) return false;
  scheds.splice(i, 1); writeSchedules(scheds); return true;
}
export function setScheduleStatus(id, patch) {
  const scheds = readSchedules(); const s = scheds.find((x) => x.id === id); if (!s) return;
  Object.assign(s, patch); writeSchedules(scheds);
}

// -------------------------------------------------------------- Run queue ----
// UI writes "run now" requests here; the bot drains them. { kind:"task"|"schedule", id, at }
export function enqueueRun(kind, id) {
  const q = readJson(RUNQ_FILE, []); (Array.isArray(q) ? q : []).push({ kind, id, at: nowIso() });
  writeJson(RUNQ_FILE, Array.isArray(q) ? q : [{ kind, id, at: nowIso() }]);
}
export function drainRunQueue() {
  const q = readJson(RUNQ_FILE, []); if (!Array.isArray(q) || !q.length) return [];
  writeJson(RUNQ_FILE, []); return q;
}
