import { useState, useEffect } from "preact/hooks";
import { api } from "./api.js";
import { toast, confirmDialog } from "./store.js";
import { Btn, IconBtn, Icon, Field, TextInput, Textarea, Card, Spinner } from "./ui.jsx";

function copy(text) {
  if (!text) return;
  navigator.clipboard.writeText(text).then(() => toast("Copied")).catch(() => toast("Copy failed", "bad"));
}

// One credential card: name, a reveal/copy value line, and optional notes.
function CredentialCard({ c, onEdit, onDuplicate, onDelete }) {
  const [shown, setShown] = useState(false);
  const hasValue = !!(c.value && c.value.length);
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
      {hasValue ? (
        <div class="row" style="margin-top:8px;gap:6px">
          <code class="mono grow" style="overflow-wrap:anywhere">{shown ? c.value : "•".repeat(Math.min(c.value.length, 24))}</code>
          <IconBtn name={shown ? "eyeoff" : "eye"} label={shown ? "Hide" : "Reveal"} onClick={() => setShown((s) => !s)} />
          <IconBtn name="link" label="Copy value" onClick={() => copy(c.value)} />
        </div>
      ) : (
        <p class="hint" style="margin-top:6px">No value set — notes only.</p>
      )}
      {c.notes && <p class="hint" style="margin-top:6px;white-space:pre-wrap">{c.notes}</p>}
    </Card>
  );
}

export function CredentialsView() {
  const [list, setList] = useState(null);
  const [err, setErr] = useState(null);
  const [editing, setEditing] = useState(null); // { id?, name, value, notes, isNew }
  const [busy, setBusy] = useState(false);

  async function load() {
    setErr(null);
    try { const r = await api("GET", "/api/credentials"); setList(r.credentials || []); }
    catch (ex) { setErr(ex.message); }
  }
  useEffect(() => { load(); }, []);

  function openNew() { setEditing({ name: "", value: "", notes: "", isNew: true }); }
  function openEdit(c) { setEditing({ id: c.id, name: c.name, value: c.value, notes: c.notes, isNew: false }); }

  async function save() {
    if (!editing) return;
    if (!editing.name.trim()) { toast("Give the credential a name.", "bad"); return; }
    setBusy(true);
    try {
      const body = { name: editing.name, value: editing.value, notes: editing.notes };
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
          <TextInput value={editing.name} onInput={(v) => setEditing((e) => ({ ...e, name: v }))} placeholder="My server login" />
        </Field>
        <Field label="Value" hint="The secret itself (password, key, token). Optional — leave blank for a notes-only entry.">
          <TextInput value={editing.value} onInput={(v) => setEditing((e) => ({ ...e, value: v }))} placeholder="hunter2 / sk-… / token" />
        </Field>
        <Field label="Notes" hint="Anything else — host, username, URL, usage. Searchable by the bot's get_credentials tool.">
          <Textarea code value={editing.notes} style="min-height:180px" onInput={(v) => setEditing((e) => ({ ...e, notes: v }))} placeholder={"host: 1.2.3.4\nuser: root\nurl: https://…"} />
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
          <p class="sub">A free-form vault for logins and keys that don't have their own plugin or MCP server — servers, one-off API keys, anything. The bot can look these up on request via its <code>get_credentials</code> tool. Stored locally (chmod 600), never sent anywhere.</p>
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
