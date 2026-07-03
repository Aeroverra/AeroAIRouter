import { useState, useEffect } from "preact/hooks";
import { api } from "./api.js";
import { toast, confirmDialog } from "./store.js";
import { Btn, IconBtn, Field, TextInput, Select, Switch, Card, Badge, StatusBadge, Spinner } from "./ui.jsx";

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const tzOff = () => new Date().getTimezoneOffset(); // UTC = local + offset (minutes)

// local time (HH:MM) + frequency + local weekdays  ->  UTC 5-field cron
function buildCron(localHHMM, freq, weekdays) {
  const [h, m] = (localHHMM || "09:00").split(":").map(Number);
  if (freq === "hourly") return (m || 0) + " * * * *";
  let total = h * 60 + (m || 0) + tzOff();
  const shift = Math.floor(total / 1440);
  total = ((total % 1440) + 1440) % 1440;
  const uh = Math.floor(total / 60), um = total % 60;
  if (freq === "daily") return um + " " + uh + " * * *";
  let days = freq === "weekdays" ? [1, 2, 3, 4, 5] : (weekdays && weekdays.length ? weekdays.slice() : [0]);
  days = [...new Set(days.map((d) => ((d + shift) % 7 + 7) % 7))].sort((a, b) => a - b);
  return um + " " + uh + " * * " + days.join(",");
}
function utcToLocal(uh, um) {
  if (isNaN(uh) || isNaN(um)) return { label: "" };
  let total = uh * 60 + um - tzOff();
  const dayShift = Math.floor(total / 1440);
  total = ((total % 1440) + 1440) % 1440;
  const h = Math.floor(total / 60), m = total % 60;
  let hr = h % 12; if (hr === 0) hr = 12;
  return { dayShift, label: hr + ":" + String(m).padStart(2, "0") + " " + (h < 12 ? "AM" : "PM") };
}
function expandDow(field) {
  const out = [];
  for (const part of String(field).split(",")) {
    if (part.includes("-")) { const [a, b] = part.split("-").map(Number); for (let i = a; i <= b; i++) out.push(i % 7); }
    else out.push(parseInt(part) % 7);
  }
  return [...new Set(out)];
}
function cronToHuman(cron) {
  const p = String(cron || "").trim().split(/\s+/);
  if (p.length !== 5) return cron || "(invalid)";
  const [mi, ho, dom, mo, dow] = p;
  if (ho === "*") return "hourly at :" + String(mi).padStart(2, "0");
  const l = utcToLocal(parseInt(ho), parseInt(mi));
  if (!l.label) return cron;
  if (dom !== "*" || mo !== "*") return cron + " (UTC)";
  if (dow === "*") return "daily · " + l.label;
  if (dow === "1-5") return "weekdays · " + l.label;
  const days = expandDow(dow).map((d) => DOW[((d + l.dayShift) % 7 + 7) % 7]);
  return days.join(", ") + " · " + l.label;
}
function fmtLocal(iso) { if (!iso) return ""; try { return new Date(iso).toLocaleString(); } catch { return iso; } }

export function SchedulerView() {
  const [schedules, setSchedules] = useState(null);
  const [tasks, setTasks] = useState([]);
  const [err, setErr] = useState(null);
  const [adding, setAdding] = useState(false);

  async function load() {
    try {
      const [s, t] = await Promise.all([api("GET", "/api/schedules"), api("GET", "/api/tasks")]);
      setSchedules(s.schedules || []); setTasks(t.tasks || []); setErr(null);
    } catch (ex) { setErr(ex.message); }
  }
  useEffect(() => { load(); }, []);

  async function toggle(s, enabled) { try { await api("PUT", "/api/schedules/" + s.id, { enabled }); load(); } catch (ex) { toast(ex.message, "bad"); } }
  async function run(s) { try { await api("POST", "/api/schedules/" + s.id + "/run"); toast("Queued to run"); setTimeout(load, 2500); } catch (ex) { toast(ex.message, "bad"); } }
  async function del(s) { if (!(await confirmDialog({ title: "Delete schedule?", danger: true, confirmLabel: "Delete", message: "Remove this schedule?" }))) return; try { await api("DELETE", "/api/schedules/" + s.id); load(); } catch (ex) { toast(ex.message, "bad"); } }

  const recurring = (schedules || []).filter((s) => s.kind !== "once");
  const oneoff = (schedules || []).filter((s) => s.kind === "once");

  return (
    <div>
      <div class="page-head"><h1>Scheduler</h1><p class="sub">Fire tasks automatically. Times are stored in UTC and shown in your local time ({Intl.DateTimeFormat().resolvedOptions().timeZone}). One-off runs stay for a week as history, then need rescheduling.</p></div>
      {err && <p class="field-err">{err}</p>}
      <div class="row" style="margin-bottom:12px">
        <Btn variant="primary" icon="plus" onClick={() => setAdding(true)} disabled={!tasks.length}>New schedule</Btn>
        {!tasks.length && <span class="hint">Create a task first (Tasks tab).</span>}
      </div>
      {adding && <AddSchedule tasks={tasks} onCancel={() => setAdding(false)} onDone={() => { setAdding(false); load(); }} />}

      {!schedules ? <p class="hint"><Spinner size={13} /> Loading…</p> : <>
        <div class="seg"><h3>Recurring</h3></div>
        {!recurring.length ? <p class="empty">No recurring schedules.</p> :
          <div class="rows">{recurring.map((s) => (
            <Card class="card-pad">
              <div class="row">
                <strong>{s.taskName}</strong>
                {s.lastStatus && <StatusBadge status={s.lastStatus === "ok" ? "connected" : "error"} error={s.lastError} />}
                <span class="spacer" />
                <Switch size="sm" checked={s.enabled} onChange={(v) => toggle(s, v)} label={s.enabled ? "on" : "off"} />
                <Btn variant="secondary" size="sm" onClick={() => run(s)}>Run now</Btn>
                <IconBtn name="trash" label="Delete" onClick={() => del(s)} />
              </div>
              <p class="hint" style="margin-top:4px">{cronToHuman(s.cron)} · <span class="mono">{s.cron}</span> UTC · last run {s.lastRunAt ? fmtLocal(s.lastRunAt) : "never"}</p>
            </Card>
          ))}</div>}

        <div class="seg" style="margin-top:16px"><h3>One-off</h3></div>
        {!oneoff.length ? <p class="empty">No one-off schedules.</p> :
          <div class="rows">{oneoff.map((s) => (
            <Card class="card-pad">
              <div class="row">
                <strong>{s.taskName}</strong>
                {s.completedAt ? <Badge>ran {fmtLocal(s.completedAt)}</Badge> : <Badge kind="brand">pending</Badge>}
                {s.lastStatus && <StatusBadge status={s.lastStatus === "ok" ? "connected" : "error"} error={s.lastError} />}
                <span class="spacer" />
                {!s.completedAt && <Btn variant="secondary" size="sm" onClick={() => run(s)}>Run now</Btn>}
                <IconBtn name="trash" label="Delete" onClick={() => del(s)} />
              </div>
              <p class="hint" style="margin-top:4px">{s.completedAt ? "fired at " : "runs at "}{fmtLocal(s.runAt)}{s.completedAt ? " · kept as history for a week" : ""}</p>
            </Card>
          ))}</div>}
      </>}
    </div>
  );
}

function AddSchedule({ tasks, onCancel, onDone }) {
  const [taskId, setTaskId] = useState(tasks[0] ? tasks[0].id : "");
  const [kind, setKind] = useState("recurring");
  const [freq, setFreq] = useState("daily");
  const [time, setTime] = useState("17:00");
  const [days, setDays] = useState([1, 2, 3, 4, 5]);
  const [rawCron, setRawCron] = useState("");
  const [runAt, setRunAt] = useState("");
  const [out, setOut] = useState("");

  const cron = freq === "custom" ? rawCron.trim() : buildCron(time, freq, days);

  async function save() {
    if (!taskId) { setOut("Pick a task"); return; }
    let payload = { taskId, kind };
    if (kind === "once") {
      if (!runAt) { setOut("Pick a date/time"); return; }
      payload.runAt = new Date(runAt).toISOString(); // datetime-local (local) -> UTC ISO
    } else {
      if (!cron || cron.split(/\s+/).length !== 5) { setOut("Invalid cron"); return; }
      payload.cron = cron;
    }
    setOut("Saving…");
    try { await api("POST", "/api/schedules", payload); toast("Scheduled"); onDone(); }
    catch (ex) { setOut("✗ " + ex.message); }
  }

  const toggleDay = (d) => setDays((ds) => ds.includes(d) ? ds.filter((x) => x !== d) : [...ds, d].sort());

  return (
    <Card class="card-pad" style="margin-bottom:14px">
      <h3 style="margin-bottom:8px">New schedule</h3>
      <Field label="Task"><Select value={taskId} options={tasks.map((t) => [t.id, t.name])} onInput={setTaskId} /></Field>
      <Field label="Kind"><Select value={kind} options={[["recurring", "recurring"], ["once", "one-off"]]} onInput={setKind} /></Field>
      {kind === "recurring" ? <>
        <Field label="Frequency"><Select value={freq} options={[["daily", "daily"], ["weekdays", "weekdays (Mon–Fri)"], ["weekly", "weekly (pick days)"], ["hourly", "hourly"], ["custom", "custom cron"]]} onInput={setFreq} /></Field>
        {freq !== "custom" && freq !== "hourly" && <Field label="Time (your local time)"><input class="input" type="time" value={time} onInput={(e) => setTime(e.target.value)} /></Field>}
        {freq === "hourly" && <Field label="Minute of the hour"><input class="input" type="time" value={time} onInput={(e) => setTime(e.target.value)} /><p class="hint">Uses the minutes; runs every hour.</p></Field>}
        {freq === "weekly" && <Field label="Days"><div class="row" style="flex-wrap:wrap;gap:4px">{DOW.map((d, i) => <button class={"tool-pill" + (days.includes(i) ? " active" : "")} style={days.includes(i) ? "background:var(--brand);color:#fff" : ""} onClick={() => toggleDay(i)}>{d}</button>)}</div></Field>}
        {freq === "custom" ? <Field label="Cron (5-field, UTC)" hint="minute hour day-of-month month day-of-week"><TextInput class="mono" value={rawCron} onInput={setRawCron} placeholder="0 22 * * 1-5" /></Field>
          : <p class="hint">Cron (UTC): <span class="mono">{cron}</span> — {cronToHuman(cron)}</p>}
      </> : <>
        <Field label="Run at (your local time)"><input class="input" type="datetime-local" value={runAt} onInput={(e) => setRunAt(e.target.value)} /></Field>
        {runAt && <p class="hint">= {new Date(runAt).toISOString()} UTC</p>}
      </>}
      <div class="row" style="margin-top:10px"><Btn variant="primary" onClick={save}>Create</Btn><Btn variant="ghost" onClick={onCancel}>Cancel</Btn><span class="hint">{out}</span></div>
    </Card>
  );
}
