import { useState, useEffect } from "preact/hooks";
import { api } from "./api.js";
import { toast, confirmDialog } from "./store.js";
import { Btn, IconBtn, Icon, Field, TextInput, Textarea, Card, Spinner } from "./ui.jsx";

function copy(text) {
  if (!text) return;
  navigator.clipboard.writeText(text).then(() => toast("Copied")).catch(() => toast("Copy failed", "bad"));
}

// A reveal/copy line for one secret value, with an optional field label.
function SecretLine({ label, value }) {
  const [shown, setShown] = useState(false);
  return (
    <div class="row" style="gap:6px;margin-top:6px">
      {label && <span class="faint caption mono" style="min-width:88px">{label}</span>}
      <code class="mono grow" style="overflow-wrap:anywhere">{shown ? value : "•".repeat(Math.min(value.length, 24))}</code>
      <IconBtn name={shown ? "eyeoff" : "eye"} label={shown ? "Hide" : "Reveal"} onClick={() => setShown((s) => !s)} />
      <IconBtn name="link" label="Copy" onClick={() => copy(value)} />
    </div>
  );
}

function CredentialCard({ c, onEdit, onDuplicate, onDelete }) {
  const fields = c.fields || [];
  const empty = !c.value && !fields.length && !c.notes;
  return (
    <Card class="plugin-card">
      <div class="row">
        <Icon name="key" size={16} />
        <strong>{c.name}</strong>
        <span class="spacer" />
        <Btn variant="secondary" size="sm" onClick={() => onEdit(c)}>Edit</Btn>
        <IconBtn name="note" label="Duplicate" onClick={() => onDuplicate(c)} />
        <IconBtn name="trash" label="Delete" onClick={() => onDelete(c)} />
      </div>
      {c.description && <p class="pc-desc" style="margin-top:4px">{c.description}</p>}
      {c.value && <SecretLine label={fields.length ? "value" : null} value={c.value} />}
      {fields.map((f) => <SecretLine label={f.key || "—"} value={f.value} />)}
      {c.notes && <p class="hint" style="margin-top:8px;white-space:pre-wrap">{c.notes}</p>}
      {empty && <p class="hint" style="margin-top:6px">Empty — click Edit to add a value or notes.</p>}
    </Card>
  );
}

function FieldsEditor({ fields, onChange }) {
  const rows = fields.length ? fields : [];
  const upd = (i, k, v) => { const next = rows.map((r, j) => (j === i ? { ...r, [k]: v } : r)); onChange(next); };
  const add = () => onChange([...rows, { key: "", value: "" }]);
  const remove = (i) => onChange(rows.filter((_, j) => j !== i));
  return (
    <div>
      {rows.map((r, i) => (
        <div class="row" style="gap:6px;margin-bottom:6px">
          <TextInput narrow value={r.key} onInput={(v) => upd(i, "key", v)} placeholder="user" />
          <TextInput class="grow" value={r.value} onInput={(v) => upd(i, "value", v)} placeholder="value" />
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
  const [editing, setEditing] = useState(null); // { id?, name, description, value, fields, notes, isNew }
  const [busy, setBusy] = useState(false);

  async function load() {
    setErr(null);
    try { const r = await api("GET", "/api/credentials"); setList(r.credentials || []); }
    catch (ex) { setErr(ex.message); }
  }
  useEffect(() => { load(); }, []);

  function openNew() { setEditing({ name: "", description: "", value: "", fields: [], notes: "", isNew: true }); }
  function openEdit(c) { setEditing({ id: c.id, name: c.name, description: c.description || "", value: c.value || "", fields: (c.fields || []).slice(), notes: c.notes || "", isNew: false }); }
  const patch = (p) => setEditing((e) => ({ ...e, ...p }));

  async function save() {
    if (!editing) return;
    if (!editing.name.trim()) { toast("Give the credential a name.", "bad"); return; }
    setBusy(true);
    try {
      const body = { name: editing.name, description: editing.description, value: editing.value, fields: editing.fields, notes: editing.notes };
      if (editing.isNew) await api("POST", "/api/credentials", body);
      else await api("PUT", "/api/credentials/" + editing.id, body);
      toast("Credential saved.");
      setEditing(null); await load();
    } catch (ex) { toast(ex.message, "bad"); }
    setBusy(false);
  }
  async function duplicate(c) {
    try { await api("POST", "/api/credentials/" + c.id + "/duplicate"); toast("Duplicated " + c.name); await load(); }
    catch (ex) { toast(ex.message, "bad"); }
  }
  async function del(c) {
    if (!(await confirmDialog({ title: "Delete credential?", message: c.name + " will be removed.", confirmLabel: "Delete", danger: true }))) return;
    try { await api("DELETE", "/api/credentials/" + c.id); toast("Deleted " + c.name); await load(); }
    catch (ex) { toast(ex.message, "bad"); }
  }

  if (editing) {
    return (
      <div>
        <Btn variant="ghost" onClick={() => setEditing(null)}>← All credentials</Btn>
        <div class="page-head" style="margin-top:8px"><h1>{editing.isNew ? "New credential" : editing.name || "Credential"}</h1></div>
        <Field label="Name" required hint="Whatever you want to call it — e.g. “VM at 1.2.3.4”, “SomeService API key”.">
          <TextInput value={editing.name} onInput={(v) => patch({ name: v })} placeholder="My server login" />
        </Field>
        <Field label="Description" hint="One line: what this is / where it's used.">
          <TextInput value={editing.description} onInput={(v) => patch({ description: v })} placeholder="Prod database box" />
        </Field>
        <Field label="Value" hint="The main secret — the thing you copy most (API key, token, or password). Optional.">
          <TextInput value={editing.value} onInput={(v) => patch({ value: v })} placeholder="sk-… / token / password" />
        </Field>
        <Field label="Extra fields" hint="For logins that need more than one part — user, host, port, etc. Each gets its own reveal/copy.">
          <FieldsEditor fields={editing.fields} onChange={(fields) => patch({ fields })} />
        </Field>
        <Field label="Notes" hint="How to use it — anything free-form. Searchable by the bot's get_credentials tool.">
          <Textarea code value={editing.notes} style="min-height:140px" onInput={(v) => patch({ notes: v })} placeholder={"reachable over tailscale; sudo needs the same pass"} />
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
          <p class="sub">A free-form vault for logins and keys that don't have their own plugin or MCP server — servers, one-off API keys, anything. Each has a main value, optional extra fields (user/host/…), and notes. The bot can look these up via its <code>get_credentials</code> tool. Stored locally (chmod 600), never sent anywhere.</p>
        </div>
        <Btn variant="primary" icon="plus" onClick={openNew}>New credential</Btn>
      </div>

      {err && <p class="field-err">{err}</p>}
      {!list ? <p class="hint"><Spinner size={13} /> Loading…</p> : list.length === 0 ? (
        <Card class="card-pad"><p class="hint">No credentials yet. Add one with <b>New credential</b>. Existing entries from the legacy <code>credentials.md</code> are imported automatically the first time this loads.</p></Card>
      ) : (
        <div class="rows">
          {list.map((c) => <CredentialCard c={c} onEdit={openEdit} onDuplicate={duplicate} onDelete={del} />)}
        </div>
      )}
    </div>
  );
}
