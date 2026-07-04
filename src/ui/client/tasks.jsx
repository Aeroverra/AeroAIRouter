import { useState, useEffect } from "preact/hooks";
import { api } from "./api.js";
import { toast, confirmDialog } from "./store.js";
import { Btn, IconBtn, Field, TextInput, Textarea, Select, Switch, Card, Badge, StatusBadge, Spinner } from "./ui.jsx";

function fmtWhen(iso) {
  if (!iso) return "never";
  try { return new Date(iso).toLocaleString(); } catch { return iso; }
}

export function TasksView() {
  const [tasks, setTasks] = useState(null);
  const [err, setErr] = useState(null);
  const [editing, setEditing] = useState(null); // task object, or { _new: true }
  const [busy, setBusy] = useState("");
  const [openLog, setOpenLog] = useState(""); // task id whose log is expanded

  async function load() { try { const r = await api("GET", "/api/tasks"); setTasks(r.tasks || []); setErr(null); } catch (ex) { setErr(ex.message); } }
  useEffect(() => { load(); }, []);

  // While any task is running, poll the list so the running badge / log update live.
  const anyRunning = !!(tasks && tasks.some((t) => t.lastStatus === "running"));
  useEffect(() => {
    if (!anyRunning) return;
    const iv = setInterval(load, 2000);
    return () => clearInterval(iv);
  }, [anyRunning]);

  async function run(t) {
    setBusy(t.id);
    try {
      await api("POST", "/api/tasks/" + t.id + "/run");
      toast("Queued \"" + t.name + "\" to run");
      setOpenLog(t.id); // reveal the log so the user sees it start
      setTimeout(load, 1500); setTimeout(load, 4000); // bridge until the running-poll takes over
    } catch (ex) { toast(ex.message, "bad"); }
    setBusy("");
  }
  async function duplicate(t) { try { await api("POST", "/api/tasks/" + t.id + "/duplicate"); toast("Duplicated"); load(); } catch (ex) { toast(ex.message, "bad"); } }
  async function del(t) {
    if (!(await confirmDialog({ title: "Delete task?", danger: true, confirmLabel: "Delete", message: "Delete \"" + t.name + "\" and any schedules that use it?" }))) return;
    try { await api("DELETE", "/api/tasks/" + t.id); toast("Deleted"); load(); } catch (ex) { toast(ex.message, "bad"); }
  }

  if (editing) return <TaskEditor task={editing} onDone={() => { setEditing(null); load(); }} onCancel={() => setEditing(null)} />;

  return (
    <div>
      <div class="page-head"><h1>Tasks</h1><p class="sub">Reusable executable units you or Azula can run — an agent prompt or a shell command. A task may run silently or post to a channel. Schedule them under Scheduler.</p></div>
      {err && <p class="field-err">{err}</p>}
      <div class="row" style="margin-bottom:12px"><Btn variant="primary" icon="plus" onClick={() => setEditing({ _new: true, type: "agent", postOutput: true })}>New task</Btn></div>
      {!tasks ? <p class="hint"><Spinner size={13} /> Loading…</p> :
        !tasks.length ? <p class="empty">No tasks yet.</p> :
        <div class="rows">{tasks.map((t) => {
          const running = t.lastStatus === "running";
          return (
          <Card class="card-pad">
            <div class="row">
              <strong>{t.name}</strong>
              <Badge kind={t.type === "command" ? "brand" : undefined}>{t.type}</Badge>
              {running
                ? <span class="row-tight" style="gap:5px;color:var(--accent,#4a9eff);font-size:12px;font-weight:600"><Spinner size={12} />running</span>
                : t.lastStatus && <StatusBadge status={t.lastStatus === "ok" ? "connected" : "error"} error={t.lastError} />}
              <span class="spacer" />
              <Btn variant="primary" size="sm" loading={busy === t.id} disabled={running} onClick={() => run(t)}>Run now</Btn>
              <Btn variant="secondary" size="sm" onClick={() => setOpenLog((v) => (v === t.id ? "" : t.id))}>{openLog === t.id ? "Hide log" : "Log"}</Btn>
              <Btn variant="secondary" size="sm" onClick={() => setEditing(t)}>Edit</Btn>
              <Btn variant="ghost" size="sm" onClick={() => duplicate(t)}>Duplicate</Btn>
              <IconBtn name="trash" label="Delete" onClick={() => del(t)} />
            </div>
            {t.description && <p class="pc-desc">{t.description}</p>}
            <p class="hint" style="margin-top:4px">
              {t.channelId ? "→ channel " + t.channelId + " · " : ""}
              {running ? "started " + fmtWhen(t.lastRunAt) : <>last run {fmtWhen(t.lastRunAt)}{t.lastStatus ? " (" + t.lastStatus + ")" : ""}</>}
            </p>
            {openLog === t.id && <TaskLog id={t.id} running={running} />}
          </Card>
          );
        })}</div>}
    </div>
  );
}

// Tails a task's log. Fetches once on open; while the task is running, polls every
// 2s so you see the output stream in. When it stops running, one final fetch grabs
// the completed log, then polling stops.
function TaskLog({ id, running }) {
  const [log, setLog] = useState(null);
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try { const r = await api("GET", "/api/tasks/" + id + "/log"); if (alive) setLog(r.log || ""); }
      catch { /* transient; keep last */ }
    };
    tick();
    if (!running) return () => { alive = false; };
    const iv = setInterval(tick, 2000);
    return () => { alive = false; clearInterval(iv); };
  }, [id, running]);

  return (
    <div style="margin-top:8px">
      {log == null ? <p class="hint"><Spinner size={12} /> loading log…</p>
        : log.trim() === "" ? <p class="hint">No output{running ? " yet…" : "."}</p>
        : <pre class="mono" style="max-height:300px;overflow:auto;white-space:pre-wrap;word-break:break-word;background:rgba(0,0,0,.28);padding:10px;border-radius:6px;font-size:12px;margin:0">{log}</pre>}
    </div>
  );
}

function TaskEditor({ task, onCancel, onDone }) {
  const isNew = !!task._new;
  const [name, setName] = useState(task.name || "");
  const [description, setDescription] = useState(task.description || "");
  const [type, setType] = useState(task.type || "agent");
  const [body, setBody] = useState(task.body || "");
  const [channelId, setChannelId] = useState(task.channelId || "");
  const [postOutput, setPostOutput] = useState(task.postOutput !== false);
  const [out, setOut] = useState("");

  async function save() {
    if (!name.trim() || !body.trim()) { setOut("Name and body are required"); return; }
    const payload = { name: name.trim(), description, type, body, channelId: channelId.trim(), postOutput };
    setOut("Saving…");
    try {
      if (isNew) await api("POST", "/api/tasks", payload);
      else await api("PUT", "/api/tasks/" + task.id, payload);
      toast("Saved task"); onDone();
    } catch (ex) { setOut("✗ " + ex.message); }
  }

  return (
    <div>
      <Btn variant="ghost" onClick={onCancel}>← Tasks</Btn>
      <div class="page-head" style="margin-top:8px"><h1>{isNew ? "New task" : "Edit task"}</h1></div>
      <Field label="Name"><TextInput value={name} onInput={setName} placeholder="Check OSRS xp" /></Field>
      <Field label="Description" hint="Optional."><TextInput value={description} onInput={setDescription} /></Field>
      <Field label="Type" hint="agent = run the body as a prompt (Azula decides whether to reply). command = run the body as a shell command.">
        <Select value={type} options={[["agent", "agent (prompt)"], ["command", "command (shell)"]]} onInput={setType} />
      </Field>
      <Field label={type === "command" ? "Shell command" : "Prompt"} hint={type === "command" ? "Runs via bash. Its own output can be posted below." : "What Azula should do. Tell her to stay silent when there's nothing to report."}>
        <Textarea code value={body} style="min-height:120px" onInput={setBody} placeholder={type === "command" ? "node ~/scripts/osrs-check.js" : "Check the OSRS xp tracker; if anyone gained xp, post a summary. Otherwise say nothing."} />
      </Field>
      <Field label="Channel ID" hint={type === "agent" ? "Required for agent tasks — where it runs / replies." : "Optional — where to post the command's output."}>
        <TextInput value={channelId} onInput={setChannelId} placeholder="123456789012345678" />
      </Field>
      <Field><Switch checked={postOutput} onChange={setPostOutput} label="post output to the channel" /></Field>
      <div class="row" style="margin-top:10px"><Btn variant="primary" onClick={save}>Save</Btn><Btn variant="ghost" onClick={onCancel}>Cancel</Btn><span class="hint">{out}</span></div>
    </div>
  );
}
