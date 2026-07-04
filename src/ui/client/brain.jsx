import { useState, useEffect } from "preact/hooks";
import { api } from "./api.js";
import { toast, confirmDialog } from "./store.js";
import { Btn, IconBtn, Icon, Field, TextInput, Textarea, Card, Badge, Switch, Spinner } from "./ui.jsx";

// ============================================================ MEMORIES =======
export function MemoriesView({ navigate }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [editing, setEditing] = useState(null); // { name, content, isNew }
  const [busy, setBusy] = useState(false);

  async function load() {
    setErr(null);
    try { setData(await api("GET", "/api/memories")); }
    catch (ex) { setErr(ex.message); }
  }
  useEffect(() => { load(); }, []);

  async function openEdit(name) {
    try { const r = await api("GET", "/api/memories/" + encodeURIComponent(name)); setEditing({ name, content: r.content, isNew: false }); }
    catch (ex) { toast(ex.message, "bad"); }
  }
  function openNew() {
    setEditing({ name: "new-note.md", content: "", isNew: true });
  }
  async function save() {
    if (!editing) return;
    setBusy(true);
    try {
      if (editing.isNew) await api("POST", "/api/memories", { name: editing.name, content: editing.content });
      else await api("PUT", "/api/memories/" + encodeURIComponent(editing.name), { content: editing.content });
      toast("Memory saved — the bot picks it up live.");
      setEditing(null); await load();
    } catch (ex) { toast(ex.message, "bad"); }
    setBusy(false);
  }
  async function del(name) {
    if (!(await confirmDialog({ title: "Delete memory?", message: name + " will be removed.", confirmLabel: "Delete", danger: true }))) return;
    try { await api("DELETE", "/api/memories/" + encodeURIComponent(name)); toast("Deleted " + name); await load(); }
    catch (ex) { toast(ex.message, "bad"); }
  }
  async function togglePin(f, pinned) {
    try { await api("POST", "/api/memories/" + encodeURIComponent(f.name) + "/pin", { pinned }); toast(pinned ? "Pinned — always in the prompt." : "Unpinned — read on demand."); await load(); }
    catch (ex) { toast(ex.message, "bad"); }
  }

  if (editing) {
    return (
      <div>
        <Btn variant="ghost" onClick={() => setEditing(null)}>← All memories</Btn>
        <div class="page-head" style="margin-top:8px"><h1>{editing.isNew ? "New memory" : editing.name}</h1></div>
        {editing.isNew && (
          <Field label="File name" hint="Name it by TOPIC, e.g. proxmox-setup.md — not a date. .md is added automatically. Use the Pin toggle on the list to keep a note always in the prompt.">
            <TextInput value={editing.name} onInput={(v) => setEditing((e) => ({ ...e, name: v }))} placeholder="proxmox-setup.md" />
          </Field>
        )}
        <Field label="Content" hint="Markdown. Injected verbatim into the bot's system prompt.">
          <Textarea code value={editing.content} style="min-height:340px" onInput={(v) => setEditing((e) => ({ ...e, content: v }))} />
        </Field>
        <div class="row"><Btn variant="primary" loading={busy} onClick={save}>Save memory</Btn><Btn variant="ghost" onClick={() => setEditing(null)}>Cancel</Btn></div>
      </div>
    );
  }

  const files = data ? data.files : null;
  const b = data && data.budget;
  return (
    <div>
      <div class="page-head page-head-row">
        <div>
          <h1>Memories</h1>
          <p class="sub">The bot's long-term notes — it writes these itself as it learns (via <code>manage_memory</code>). Every note is listed in an always-on index; <b>pinned</b> notes are injected into the prompt in full on every message, and the rest are read on demand when a topic is relevant. Toggle the <b>Pin</b> switch to control that. Changes apply live, no restart.</p>
        </div>
        <Btn variant="primary" icon="plus" onClick={openNew}>New memory</Btn>
      </div>

      <Card class="card-pad" style="margin-bottom:16px">
        <div class="row"><Icon name="persona" size={18} /><strong>Core memory</strong><span class="spacer" />
          <Btn variant="secondary" size="sm" onClick={() => navigate("persona")}>Edit in Persona →</Btn></div>
        <p class="hint" style="margin-top:6px">Your hand-written <code>memory.md</code> is always loaded in full as long-term memory. Edit it on the Persona tab. The notes below are the bot's own rolling memory.</p>
      </Card>

      {b && <p class="hint" style="margin-bottom:10px"><b>{files.filter((f) => f.pinned).length}</b> pinned (in the prompt, <b>{Math.round(b.usedBytes / 1024)}KB</b> / {Math.round(b.maxBytes / 1024)}KB budget) · <b>{files.filter((f) => !f.pinned).length}</b> read on demand from the index.</p>}

      {err && <p class="field-err">{err}</p>}
      {!data ? <p class="hint"><Spinner size={13} /> Loading…</p> : files.length === 0 ? (
        <Card class="card-pad"><p class="hint">No memories yet. The bot will create them as it learns, or add one with <b>New memory</b>.</p></Card>
      ) : (
        <div class="rows">
          {files.map((f) => (
            <Card class="plugin-card">
              <div class="row">
                <Icon name="note" size={16} />
                <strong class="mono" style="font-size:13px">{f.name}</strong>
                {f.loaded ? <Badge kind="set">in prompt</Badge> : (f.pinned ? <span class="badge off" title={f.reason}>over budget</span> : <span class="faint caption">on demand</span>)}
                <span class="faint caption">{Math.round(f.bytes / 1024) || "<1"}KB</span>
                <span class="spacer" />
                <Switch size="sm" checked={f.pinned} onChange={(v) => togglePin(f, v)} label={f.pinned ? "pinned" : "pin"} />
                <Btn variant="secondary" size="sm" onClick={() => openEdit(f.name)}>Edit</Btn>
                <IconBtn name="trash" label="Delete" onClick={() => del(f.name)} />
              </div>
              {f.pinned && !f.loaded && <p class="hint" style="margin-top:6px">{f.reason}.</p>}
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

// ============================================================ SKILLS =========
export function SkillsView() {
  const [list, setList] = useState(null);
  const [err, setErr] = useState(null);
  const [editing, setEditing] = useState(null); // { slug, name, description, body, isNew }
  const [importing, setImporting] = useState(false);
  const [busy, setBusy] = useState(false);

  async function load() {
    setErr(null);
    try { const r = await api("GET", "/api/skills"); setList(r.skills || []); }
    catch (ex) { setErr(ex.message); }
  }
  useEffect(() => { load(); }, []);

  async function openEdit(slug) {
    try { const r = await api("GET", "/api/skills/" + slug); setEditing({ slug, name: r.name, description: r.description, body: r.body, isNew: false }); }
    catch (ex) { toast(ex.message, "bad"); }
  }
  function openNew() { setEditing({ slug: "", name: "", description: "", body: "", isNew: true }); }

  function deriveSlug(name) { return String(name || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64); }

  async function save() {
    if (!editing) return;
    const slug = editing.isNew ? deriveSlug(editing.slug || editing.name) : editing.slug;
    if (!slug) { toast("Give the skill a name.", "bad"); return; }
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(slug)) { toast("Name must produce a slug of lowercase letters, digits, - or _.", "bad"); return; }
    setBusy(true);
    try {
      await api("PUT", "/api/skills/" + slug, { name: editing.name || slug, description: editing.description, body: editing.body });
      toast("Skill saved.");
      setEditing(null); await load();
    } catch (ex) { toast(ex.message, "bad"); }
    setBusy(false);
  }
  async function toggle(s, enabled) {
    try { await api("PUT", "/api/skills/" + s.slug + "/enabled", { enabled }); s.enabled = enabled; setList((l) => l.slice()); toast((enabled ? "Enabled " : "Disabled ") + s.name + ". Restart the bot to apply."); }
    catch (ex) { toast(ex.message, "bad"); }
  }
  async function del(s) {
    if (!(await confirmDialog({ title: "Delete skill?", message: s.name + " will be removed.", confirmLabel: "Delete", danger: true }))) return;
    try { await api("DELETE", "/api/skills/" + s.slug); toast("Deleted " + s.name); await load(); }
    catch (ex) { toast(ex.message, "bad"); }
  }

  if (editing) {
    return (
      <div>
        <Btn variant="ghost" onClick={() => setEditing(null)}>← All skills</Btn>
        <div class="page-head" style="margin-top:8px"><h1>{editing.isNew ? "New skill" : editing.name || editing.slug}</h1></div>
        <div class="field-grid">
          <Field label="Name" required><TextInput value={editing.name} onInput={(v) => setEditing((e) => ({ ...e, name: v }))} placeholder="PDF report builder" /></Field>
          <Field label="Folder slug" hint={editing.isNew ? "Derived from the name; lowercase letters/digits/-/_." : "Fixed once created."}>
            <TextInput value={editing.isNew ? (editing.slug || deriveSlug(editing.name)) : editing.slug} onInput={(v) => setEditing((e) => ({ ...e, slug: v }))} disabled={!editing.isNew} />
          </Field>
        </div>
        <Field label="Description" required hint="One line. This is the ONLY part the bot sees by default — it decides from this whether to load the skill.">
          <TextInput value={editing.description} onInput={(v) => setEditing((e) => ({ ...e, description: v }))} placeholder="Turn a dataset into a polished multi-page PDF report" />
        </Field>
        <Field label="Instructions" hint="The full skill body (markdown). Loaded on demand when the bot calls use_skill.">
          <Textarea code value={editing.body} style="min-height:320px" onInput={(v) => setEditing((e) => ({ ...e, body: v }))} placeholder={"## When to use\n...\n\n## Steps\n1. ..."} />
        </Field>
        <div class="row"><Btn variant="primary" loading={busy} onClick={save}>Save skill</Btn><Btn variant="ghost" onClick={() => setEditing(null)}>Cancel</Btn></div>
      </div>
    );
  }

  return (
    <div>
      <div class="page-head page-head-row">
        <div>
          <h1>Skills</h1>
          <p class="sub">On-demand instruction packs. Each enabled skill's <b>name + one-line description</b> goes into the bot's prompt (cheap); it loads the full instructions only when a task matches, via its <code>use_skill</code> tool. Body/description edits apply live; enabling or disabling one needs a bot restart.</p>
        </div>
        <div class="row-tight"><Btn variant="secondary" icon="link" onClick={() => setImporting(true)}>Import</Btn><Btn variant="primary" icon="plus" onClick={openNew}>New skill</Btn></div>
      </div>

      {importing && <ImportPanel onClose={() => setImporting(false)} onDone={async () => { setImporting(false); await load(); }} />}

      {err && <p class="field-err">{err}</p>}
      {!list ? <p class="hint"><Spinner size={13} /> Loading…</p> : list.length === 0 ? (
        <Card class="card-pad"><p class="hint">No skills yet. Create one, or <b>Import</b> from a raw markdown URL (e.g. a SKILL.md on GitHub) or pasted markdown. A skill is a folder <code>skills/&lt;slug&gt;/SKILL.md</code> with <code>name:</code> + <code>description:</code> frontmatter.</p></Card>
      ) : (
        <div class="rows">
          {list.map((s) => (
            <Card class="plugin-card">
              <div class="row">
                <Icon name="spark" size={16} />
                <strong>{s.name}</strong>
                {s.error && <Badge kind="danger">error</Badge>}
                <span class="faint caption mono">{s.slug}</span>
                <span class="spacer" />
                <Switch checked={s.enabled} onChange={(v) => toggle(s, v)} label={s.enabled ? "enabled" : "disabled"} />
              </div>
              {s.description && <p class="hint" style="margin-top:6px">{s.description}</p>}
              {s.error && <p class="field-err">{s.error}</p>}
              <div class="plugin-actions">
                <Btn variant="secondary" size="sm" onClick={() => openEdit(s.slug)}>Edit</Btn>
                <span class="spacer" />
                <Btn variant="danger" size="sm" onClick={() => del(s)}>Delete</Btn>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

function ImportPanel({ onClose, onDone }) {
  const [url, setUrl] = useState("");
  const [md, setMd] = useState("");
  const [slug, setSlug] = useState("");
  const [busy, setBusy] = useState(false);
  async function run(body) {
    setBusy(true);
    try { const r = await api("POST", "/api/skills/import", body); toast("Imported skill: " + (r.name || r.slug)); onDone(); }
    catch (ex) { toast(ex.message, "bad"); }
    setBusy(false);
  }
  return (
    <Card class="card-pad" style="margin-bottom:16px">
      <div class="row"><strong>Import a skill</strong><span class="spacer" /><IconBtn name="close" label="Close" onClick={onClose} /></div>
      <Field label="From a raw URL" hint="A raw SKILL.md (https). e.g. raw.githubusercontent.com/…/SKILL.md">
        <div class="row"><TextInput class="grow" value={url} onInput={setUrl} placeholder="https://raw.githubusercontent.com/owner/repo/main/skills/x/SKILL.md" />
          <Btn variant="secondary" loading={busy} onClick={() => url.trim() && run({ url: url.trim(), slug: slug.trim() || undefined })}>Fetch</Btn></div>
      </Field>
      <Field label="…or paste markdown" hint="Include ---\\nname:\\ndescription:\\n--- frontmatter, or set an override slug below.">
        <Textarea code value={md} style="min-height:120px" onInput={setMd} placeholder={"---\nname: My Skill\ndescription: what it does\n---\n\ninstructions…"} />
      </Field>
      <div class="row">
        <TextInput narrow value={slug} onInput={setSlug} placeholder="override slug (optional)" />
        <Btn variant="primary" loading={busy} onClick={() => md.trim() && run({ markdown: md, slug: slug.trim() || undefined })}>Import pasted</Btn>
      </div>
    </Card>
  );
}
