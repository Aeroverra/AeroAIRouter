// Cron engine (bot process only). Fires TASKS on a schedule. A schedule references
// a task by id (see task-store.js) and is either recurring (a 5-field cron, UTC) or
// one-off (an ISO-UTC runAt). Also drains the "run now" queue the config UI writes.
// Everything is stored/evaluated in UTC; the UI converts to the viewer's local time.
import { readSchedules, writeSchedules, setScheduleStatus, drainRunQueue } from "./task-store.js";
import { runTask } from "./tasks.js";

let ticking = false;
let lastMinute = "";
let tickTimer = null;
let queueTimer = null;

// ---- minimal 5-field cron matcher (min hour day-of-month month day-of-week), UTC ----
function fieldMatch(field, value, min, max) {
  if (!field || field === "*") return true;
  for (const part of String(field).split(",")) {
    let step = 1, range = part;
    const slash = part.indexOf("/");
    if (slash >= 0) { step = parseInt(part.slice(slash + 1)) || 1; range = part.slice(0, slash); }
    let lo, hi;
    if (range === "*" || range === "") { lo = min; hi = max; }
    else if (range.includes("-")) { const [a, b] = range.split("-"); lo = parseInt(a); hi = parseInt(b); }
    else { lo = hi = parseInt(range); }
    if (isNaN(lo)) continue;
    if (isNaN(hi)) hi = lo;
    for (let v = lo; v <= hi; v += step) if (v === value) return true;
  }
  return false;
}
export function cronMatches(cron, d) {
  const p = String(cron || "").trim().split(/\s+/);
  if (p.length !== 5) return false;
  return fieldMatch(p[0], d.getUTCMinutes(), 0, 59)
    && fieldMatch(p[1], d.getUTCHours(), 0, 23)
    && fieldMatch(p[2], d.getUTCDate(), 1, 31)
    && fieldMatch(p[3], d.getUTCMonth() + 1, 1, 12)
    && fieldMatch(p[4], d.getUTCDay(), 0, 6); // 0=Sunday
}

async function fireSchedule(s) {
  setScheduleStatus(s.id, { lastRunAt: new Date().toISOString() });
  const r = await runTask(s.taskId, { source: "schedule" });
  setScheduleStatus(s.id, { lastStatus: r.success ? "ok" : "error", lastError: r.error || null });
}

async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    const now = new Date();
    const minuteKey = now.toISOString().slice(0, 16); // fire each cron at most once per minute
    if (minuteKey === lastMinute) return;
    lastMinute = minuteKey;

    let scheds = readSchedules();
    let changed = false;
    for (const s of scheds) {
      if (s.enabled === false) continue;
      if (s.kind === "once") {
        if (!s.completedAt && s.runAt && new Date(s.runAt).getTime() <= now.getTime()) {
          s.completedAt = now.toISOString();
          changed = true;
          fireSchedule(s).catch(() => {});
        }
      } else if (s.cron && cronMatches(s.cron, now)) {
        fireSchedule(s).catch(() => {});
      }
    }
    // One-offs linger a week after completion (as run history), then auto-remove.
    const weekAgo = now.getTime() - 7 * 24 * 60 * 60 * 1000;
    const kept = scheds.filter((s) => !(s.kind === "once" && s.completedAt && new Date(s.completedAt).getTime() < weekAgo));
    if (kept.length !== scheds.length) { scheds = kept; changed = true; }
    if (changed) writeSchedules(scheds);
  } finally {
    ticking = false;
  }
}

async function drain() {
  const items = drainRunQueue();
  for (const it of items) {
    try {
      if (it.kind === "schedule") {
        const s = readSchedules().find((x) => x.id === it.id);
        if (s) await fireSchedule(s);
      } else {
        await runTask(it.id, { source: "manual" });
      }
    } catch (e) { console.error("[cron] run-now failed: " + e.message); }
  }
}

export function initScheduler() {
  const n = readSchedules().length;
  console.log("[cron] Scheduler initialized (" + n + " schedule(s), UTC)");
  if (tickTimer) clearInterval(tickTimer);
  if (queueTimer) clearInterval(queueTimer);
  tickTimer = setInterval(() => tick().catch(() => {}), 20 * 1000); // dedups to 1/min
  queueTimer = setInterval(() => drain().catch(() => {}), 4 * 1000); // "run now" latency <= 4s
  drain().catch(() => {});
}

export function stopScheduler() {
  if (tickTimer) clearInterval(tickTimer);
  if (queueTimer) clearInterval(queueTimer);
  tickTimer = queueTimer = null;
}
