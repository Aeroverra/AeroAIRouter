import { useState, useEffect } from "preact/hooks";
import { api } from "./api.js";
import { toast, confirmDialog } from "./store.js";
import { Btn, IconBtn, Icon, Field, TextInput, Textarea, Switch, Card, Spinner } from "./ui.jsx";

function copy(text) {
  if (!text) return;
  navigator.clipboard.writeText(text).then(() => toast("Copied")).catch(() => toast("Copy failed", "bad"));
}

// One field row on a card. shownValue == null means "masked" (secret, not revealed).
function FieldLine({ label, secret, hasValue, shownValue }) {
  const empty = !hasValue && !shownValue;
  const masked = shownValue == null && !empty;
  return (
    <div class="row" style="gap:6px;margin-top:6px">
      <span class="faint caption mono" style="min-width:96px">{label || "—"}</span>
      {empty
        ? <span class="hint grow">(empty)</span>
        : <code class="mono grow" style="overflow-wrap:anywhere">{masked ? "••••••••••" : shownValue}</code>}
      {secret && <span class="faint caption">secret</span>}
      {!masked && !empty && <IconBtn name="link" label="Copy" onClick={() => copy(shownValue)} />}
    </div>
  );
}

function CredentialCard({ c, onEdit, onDuplicate, onDelete, onToMemory }) {
  const fields = c.fields || [];
  const hasSecret = fields.some((f) => f.secret && f.hasValue);
  const [revealed, setRevealed] = useState(null); // { [index]: value } after reveal
  async function toggleReveal() {
    if (revealed) { setRevealed(null); return; }
    try {
      const r = await api("POST", "/api/credentials/" + c.id + "/reveal");
      const map = {}; (r.credential.fields || []).forEach((rf, i) => (map[i] = rf.value));
      setRevealed(map);
    } catch (ex) { toast(ex.message, "bad"); }
  }
  return (
    <Card class="plugin-card">
      <div class="row">
        <Icon name="key" size={16} />
        <strong>{c.name}</strong>
        <span class="spacer" />
        {hasSecret && <Btn variant="secondary" size="sm" onClick={toggleReveal}>{revealed ? "Hide" : "Reveal"}</Btn>}
        <Btn variant="secondary" size="sm" onClick={() => onEdit(c)}>Edit</Btn>
        <Btn variant="ghost" size="sm" onClick={() => onToMemory(c)}>→ Memories</Btn>
        <IconBtn name="note" label="Duplicate" onClick={() => onDuplicate(c)} />
        <IconBtn name="trash" label="Delete" onClick={() => onDelete(c)} />
      </div>
      {c.description && <p class="pc-desc" style="margin-top:4px">{c.description}</p>}
      {fields.map((f, i) => (
        <FieldLine label={f.label} secret={f.secret} hasValue={f.hasValue || !!f.value}
          shownValue={f.secret ? (revealed ? revealed[i] : null) : f.value} />
      ))}
      {!fields.length && !c.notes && <p class="hint" style="margin-top:6px">Empty — click Edit to add fields.</p>}
      {c.notes && <p class="hint" style="margin-top:8px;white-space:pre-wrap">{c.notes}</p>}
    </Card>
  );
}

function FieldsEditor({ fields, onChange }) {
  const rows = fields || [];
  const upd = (i, k, v) => onChange(rows.map((r, j) => (j === i ? { ...r, [k]: v } : r)));
  const add = () => onChange([...rows, { label: "", value: "", secret: false }]);
  const remove = (i) => onChange(rows.filter((_, j) => j !== i));
  return (
    <div>
      {rows.map((r, i) => (
        <div class="row" style="gap:6px;margin-bottom:6px;flex-wrap:wrap">
          <TextInput narrow value={r.label} onInput={(v) => upd(i, "label", v)} placeholder="username" />
          <TextInput class="grow" type={r.secret ? "password" : "text"} value={r.value} onInput={(v) => upd(i, "value", v)} placeholder="value" />
          <Switch size="sm" checked={!!r.secret} onChange={(v) => upd(i, "secret", v)} label="secret" />
          <IconBtn name="trash" label="Remove field" onClick={() => remove(i)} />
        </div>
      ))}
      <Btn variant="secondary" size="sm" icon="plus" onClick={add}>Add field</Btn>
    </div>
  );
}

export function CredentialsView() {
  const [list, setList] = useState(null);
  const [err, setErr] = useState(null);
  const [editing, setEditing] = useState(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    setErr(null);
    try { const r = await api("GET", "/api/credentials"); setList(r.credentials || []); }
    catch (ex) { setErr(ex.message); }
  }
  useEffect(() => { load(); }, []);

  function openNew() { setEditing({ name: "", description: "", fields: [{ label: "username", value: "", secret: false }, { label: "password", value: "", secret: true }], notes: "", isNew: true }); }
  async function openEdit(c) {
    // Fetch the full (unmasked) values so the editor has them.
    try {
      const r = await api("POST", "/api/credentials/" + c.id + "/reveal");
      const full = r.credential;
      setEditing({ id: c.id, name: full.name, description: full.description || "", fields: (full.fields || []).map((f) => ({ ...f })), notes: full.notes || "", isNew: false });
    } catch (ex) { toast(ex.message, "bad"); }
  }
  const patch = (p) => setEditing((e) => ({ ...e, ...p }));

  async function save() {
    if (!editing) return;
    if (!editing.name.trim()) { toast("Give the credential a name.", "bad"); return; }
    setBusy(true);
    try {
      const body = { name: editing.name, description: editing.description, fields: editing.fields, notes: editing.notes };
      if (editing.isNew) await api("POST", "/api/credentials", body);
      else await api("PUT", "/api/credentials/" + editing.id, body);
      toast("Credential saved."); setEditing(null); await load();
    } catch (ex) { toast(ex.message, "bad"); }
    setBusy(false);
  }
  async function duplicate(c) { try { await api("POST", "/api/credentials/" + c.id + "/duplicate"); toast("Duplicated " + c.name); await load(); } catch (ex) { toast(ex.message, "bad"); } }
  async function del(c) {
    if (!(await confirmDialog({ title: "Delete credential?", message: c.name + " will be removed.", confirmLabel: "Delete", danger: true }))) return;
    try { await api("DELETE", "/api/credentials/" + c.id); toast("Deleted " + c.name); await load(); } catch (ex) { toast(ex.message, "bad"); }
  }
  async function toMemory(c) {
    const hasSecret = (c.fields || []).some((f) => f.secret && f.hasValue);
    const message = hasSecret
      ? c.name + " has secret fields — moving it to Memories puts those values into the bot's prompt. Only do this for non-sensitive notes."
      : "Move “" + c.name + "” into Memories as a note and remove it from Credentials?";
    if (!(await confirmDialog({ title: "Move to Memories?", message, confirmLabel: "Move", danger: hasSecret }))) return;
    try { await api("POST", "/api/credentials/" + c.id + "/to-memory"); toast("Moved to Memories"); await load(); }
    catch (ex) { toast(ex.message, "bad"); }
  }

  if (editing) {
    return (
      <div>
        <Btn variant="ghost" onClick={() => setEditing(null)}>← All credentials</Btn>
        <div class="page-head" style="margin-top:8px"><h1>{editing.isNew ? "New credential" : editing.name || "Credential"}</h1></div>
        <Field label="Name" required hint="What this set is — e.g. “VM at 1.2.3.4”, “SomeService API”.">
          <TextInput value={editing.name} onInput={(v) => patch({ name: v })} placeholder="My server login" />
        </Field>
        <Field label="Description" hint="One line: what this is / where it's used.">
          <TextInput value={editing.description} onInput={(v) => patch({ description: v })} placeholder="Prod database box" />
        </Field>
        <Field label="Fields" hint="Add as many labelled parts as you need — username, password, host, port, API key… Flip “secret” on anything that should be hidden + redacted.">
          <FieldsEditor fields={editing.fields} onChange={(fields) => patch({ fields })} />
        </Field>
        <Field label="Notes" hint="How to use it — free-form. Searchable by the bot's get_credentials tool.">
          <Textarea code value={editing.notes} style="min-height:120px" onInput={(v) => patch({ notes: v })} placeholder={"reachable over tailscale; sudo needs the same pass"} />
        </Field>
        <div class="row"><Btn variant="primary" loading={busy} onClick={save}>Save credential</Btn><Btn variant="ghost" onClick={() => setEditing(null)}>Cancel</Btn></div>
      </div>
    );
  }

  return (
    <div>
      <div class="page-head page-head-row">
        <div>
          <h1>Credentials</h1>
          <p class="sub">A vault for logins and keys that don't have their own plugin — servers, API keys, anything. Each named set has as many labelled fields as you need (username, password, host…), plus notes. Secret fields are masked here (reveal to view) and auto-redacted from Discord. The bot looks these up via <code>get_credentials</code>. Stored locally (chmod 600).</p>
        </div>
        <Btn variant="primary" icon="plus" onClick={openNew}>New credential</Btn>
      </div>

      {err && <p class="field-err">{err}</p>}
      {!list ? <p class="hint"><Spinner size={13} /> Loading…</p> : list.length === 0 ? (
        <Card class="card-pad"><p class="hint">No credentials yet. Add one with <b>New credential</b>. Legacy <code>credentials.md</code> entries import automatically on first load.</p></Card>
      ) : (
        <div class="rows">{list.map((c) => <CredentialCard c={c} onEdit={openEdit} onDuplicate={duplicate} onDelete={del} onToMemory={toMemory} />)}</div>
      )}
    </div>
  );
}
