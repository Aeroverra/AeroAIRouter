// Design-system components. All presentational; no API calls.
import { useState, useEffect, useRef } from "preact/hooks";
import { S, dismissToast } from "./store.js";

// ---------------------------------------------------------------- icons -----
const PATHS = {
  dashboard: "M3 13h8V3H3v10Zm0 8h8v-6H3v6Zm10 0h8V11h-8v10Zm0-18v6h8V3h-8Z",
  discord: "M19 6a16 16 0 0 0-4-1l-.3.6a12 12 0 0 1 3.5 1.2A14 14 0 0 0 5.8 6.8 12 12 0 0 1 9.3 5.6L9 5a16 16 0 0 0-4 1C2.5 9.6 2 13.2 2.2 16.8A15 15 0 0 0 7 19l.6-1c-.8-.3-1.5-.7-2.2-1.2l.5-.4a10 10 0 0 0 8.2 0l.5.4c-.7.5-1.4.9-2.2 1.2l.6 1a15 15 0 0 0 4.8-2.2c.3-4.2-.6-7.7-2.4-10ZM8.7 14.7c-.8 0-1.4-.8-1.4-1.7s.6-1.7 1.4-1.7 1.4.8 1.4 1.7-.6 1.7-1.4 1.7Zm6.6 0c-.8 0-1.4-.8-1.4-1.7s.6-1.7 1.4-1.7 1.4.8 1.4 1.7-.6 1.7-1.4 1.7Z",
  persona: "M12 12a5 5 0 1 0 0-10 5 5 0 0 0 0 10Zm0 2c-4 0-8 2-8 5v3h16v-3c0-3-4-5-8-5Z",
  review: "M12 3 4 6v6c0 4 3 7 8 9 5-2 8-5 8-9V6l-8-3Zm-1 12-3-3 1.4-1.4L11 12.2l4.6-4.6L17 9l-6 6Z",
  update: "M12 6V3L8 7l4 4V8a4 4 0 1 1-4 4H6a6 6 0 1 0 6-6Z",
  network: "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm0 2c1.2 0 2.7 2 3.2 5H8.8C9.3 6 10.8 4 12 4Zm-5.7 5A8 8 0 0 1 9 4.6 12 12 0 0 0 7.8 9H6.3Zm0 6h1.5A12 12 0 0 0 9 19.4 8 8 0 0 1 6.3 15Zm5.7 5c-1.2 0-2.7-2-3.2-5h6.4c-.5 3-2 5-3.2 5Zm-3.5-7a18 18 0 0 1 0-2h7a18 18 0 0 1 0 2H8.5Zm6.5 6.4A12 12 0 0 0 16.2 15h1.5a8 8 0 0 1-2.7 4.4ZM16.2 9A12 12 0 0 0 15 4.6 8 8 0 0 1 17.7 9h-1.5Z",
  plugins: "M14 3v4h2V3h2v4h1a1 1 0 0 1 1 1v3a4 4 0 0 1-4 4v3a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2v-3a4 4 0 0 1-4-4V8a1 1 0 0 1 1-1h1V3h2v4h2V3h2Z",
  mcp: "M13 2 3 14h6l-1 8 11-13h-7l1-7Z",
  raw: "M9 4 4 12l5 8M15 4l5 8-5 8",
  restart: "M12 4V1L8 5l4 4V6a6 6 0 1 1-6 6H4a8 8 0 1 0 8-8Z",
  menu: "M3 6h18M3 12h18M3 18h18",
  close: "M6 6l12 12M18 6 6 18",
  eye: "M12 5C5 5 1 12 1 12s4 7 11 7 11-7 11-7-4-7-11-7Zm0 11a4 4 0 1 1 0-8 4 4 0 0 1 0 8Z",
  eyeoff: "M2 2l20 20M9 5a11 11 0 0 1 3-.4c7 0 11 7.4 11 7.4a18 18 0 0 1-3 3.8M6 7A18 18 0 0 0 1 12s4 7 11 7a11 11 0 0 0 3.6-.6M9.5 9.5a4 4 0 0 0 5 5",
  plus: "M12 5v14M5 12h14",
  trash: "M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13",
  sun: "M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10ZM12 1v3M12 20v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M1 12h3M20 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1",
  moon: "M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z",
  check: "M5 12l5 5L20 7",
  chevron: "M9 6l6 6-6 6",
  link: "M10 13a5 5 0 0 0 7 0l2-2a5 5 0 0 0-7-7l-1 1M14 11a5 5 0 0 0-7 0l-2 2a5 5 0 0 0 7 7l1-1",
  cog: "M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6Zm8.4 3a8 8 0 0 0-.1-1.3l2-1.6-2-3.4-2.4 1a8 8 0 0 0-2.2-1.3L15.3 2H8.7l-.4 2.4a8 8 0 0 0-2.2 1.3l-2.4-1-2 3.4 2 1.6a8 8 0 0 0 0 2.6l-2 1.6 2 3.4 2.4-1a8 8 0 0 0 2.2 1.3l.4 2.4h6.6l.4-2.4a8 8 0 0 0 2.2-1.3l2.4 1 2-3.4-2-1.6c.1-.4.1-.9.1-1.3Z",
};
export function Icon({ name, size = 18, ...rest }) {
  const d = PATHS[name];
  if (!d) return null;
  const fill = ["dashboard", "discord", "persona", "review", "plugins", "mcp", "moon"].includes(name);
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true"
      fill={fill ? "currentColor" : "none"} stroke={fill ? "none" : "currentColor"}
      stroke-width="2" stroke-linecap="round" stroke-linejoin="round" {...rest}>
      <path d={d} />
    </svg>
  );
}

// --------------------------------------------------------------- spinner ----
export const Spinner = ({ size = 16 }) => <span class="spin" style={`width:${size}px;height:${size}px`} />;

// ---------------------------------------------------------------- button ----
export function Btn({ variant = "secondary", size, icon, loading, children, class: cls = "", ...rest }) {
  const sz = size === "sm" ? " btn-sm" : size === "lg" ? " btn-lg" : "";
  return (
    <button class={`btn btn-${variant}${sz} ${cls}`} disabled={rest.disabled || loading} {...rest}>
      {loading ? <Spinner size={14} /> : icon ? <Icon name={icon} size={size === "sm" ? 15 : 17} /> : null}
      {children}
    </button>
  );
}
export function IconBtn({ name, label, size = 18, class: cls = "", ...rest }) {
  return <button class={`btn-icon ${cls}`} aria-label={label} title={label} {...rest}><Icon name={name} size={size} /></button>;
}

// ---------------------------------------------------------------- field -----
export function Field({ label, hint, error, required, htmlFor, children, class: cls = "" }) {
  return (
    <div class={`field ${cls}`}>
      {label && <label for={htmlFor}>{label}{required && <span class="req">*</span>}</label>}
      {children}
      {error && <span class="field-err">{error}</span>}
      {hint && <span class="hint">{hint}</span>}
    </div>
  );
}

let _id = 0;
export function useId(prefix = "f") { const r = useRef(); if (!r.current) r.current = `${prefix}-${++_id}`; return r.current; }

// inputs -----------------------------------------------------------------
export function TextInput({ value, onInput, narrow, class: cls = "", ...rest }) {
  return <input type="text" class={`input ${narrow ? "input-narrow" : ""} ${cls}`} value={value ?? ""}
    onInput={(e) => onInput && onInput(e.target.value)} {...rest} />;
}
export function NumberInput({ value, onInput, ...rest }) {
  return <input type="text" inputMode="numeric" class="input input-narrow" value={value == null ? "" : String(value)}
    onInput={(e) => { const v = e.target.value; const n = Number(v); onInput && onInput(v === "" ? undefined : (isNaN(n) ? v : n)); }} {...rest} />;
}
export function Select({ value, options, onInput, narrow, ...rest }) {
  return (
    <select class={`select ${narrow ? "input-narrow" : ""}`} value={value} onChange={(e) => onInput && onInput(e.target.value)} {...rest}>
      {options.map((o) => { const [v, t] = Array.isArray(o) ? o : [o, o]; return <option value={v}>{t}</option>; })}
    </select>
  );
}
export function Textarea({ value, onInput, code, class: cls = "", ...rest }) {
  return <textarea class={`textarea ${code ? "code" : ""} ${cls}`} value={value ?? ""}
    onInput={(e) => onInput && onInput(e.target.value)} {...rest} />;
}
export function Switch({ checked, onChange, label, size }) {
  return (
    <label class={`switch ${size === "sm" ? "sm" : ""}`}>
      <input type="checkbox" checked={!!checked} onChange={(e) => onChange && onChange(e.target.checked)} />
      <span class="track" />
      {label && <span>{label}</span>}
    </label>
  );
}

// ---------------------------------------------------------------- card ------
export const Card = ({ children, class: cls = "", dim }) => <div class={`card ${dim ? "dim" : ""} ${cls}`}>{children}</div>;
export const Badge = ({ kind, children }) => <span class={`badge ${kind || ""}`}>{children}</span>;
export function StatusBadge({ status, error }) {
  const cls = status === "connected" ? "ok" : status === "error" ? "err" : status === "not running" ? "idle" : "idle";
  return <span class={`status ${cls}`} title={error || ""}><span class="dot" />{status}</span>;
}
export const Chip = ({ children, brand, onRemove }) => (
  <span class={`chip ${brand ? "brand" : ""}`}>{children}{onRemove && <button onClick={onRemove} aria-label="remove"><Icon name="close" size={12} /></button>}</span>
);

// ---------------------------------------------------------- toast host ------
export function ToastHost() {
  const list = S.toasts.value;
  if (!list.length) return null;
  return (
    <div class="toasts">
      {list.map((t) => (
        <div key={t.id} class={`toast ${t.kind === "bad" ? "bad" : t.kind === "info" ? "info" : ""}`}>
          <span class="t-msg">{t.msg}</span>
          <button class="t-close" aria-label="dismiss" onClick={() => dismissToast(t.id)}><Icon name="close" size={13} /></button>
        </div>
      ))}
    </div>
  );
}

// --------------------------------------------------------- dialog host ------
export function DialogHost() {
  const d = S.dialog.value;
  if (!d) return null;
  return <DialogInner d={d} />;
}
function DialogInner({ d }) {
  const isPrompt = d.type === "prompt";
  const init = {};
  if (isPrompt) for (const f of d.fields || []) init[f.name] = f.value || "";
  const [vals, setVals] = useState(init);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const firstRef = useRef();

  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") d._resolve(isPrompt ? null : false); };
    window.addEventListener("keydown", onKey);
    if (firstRef.current) firstRef.current.focus();
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  async function confirm() {
    if (isPrompt && d.validate) { const e = d.validate(vals); if (e) { setErr(e); return; } }
    if (d.onConfirm) {
      setBusy(true);
      try { const r = await d.onConfirm(isPrompt ? vals : undefined); d._resolve(r === undefined ? (isPrompt ? vals : true) : r); }
      catch (ex) { setErr(ex.message); setBusy(false); }
    } else d._resolve(isPrompt ? vals : true);
  }

  return (
    <div class="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) d._resolve(isPrompt ? null : false); }}>
      <div class="dialog" role="dialog" aria-modal="true">
        <div class="dialog-head"><h3>{d.title}</h3></div>
        <div class="dialog-body">
          {d.message && <p>{d.message}</p>}
          {isPrompt && (d.fields || []).map((f, i) => (
            <Field label={f.label} hint={f.hint}>
              <input ref={i === 0 ? firstRef : null} class="input" type={f.type || "text"} placeholder={f.placeholder || ""}
                value={vals[f.name]} onInput={(e) => setVals({ ...vals, [f.name]: e.target.value })}
                onKeyDown={(e) => { if (e.key === "Enter" && f.type !== "textarea") confirm(); }} />
            </Field>
          ))}
          {err && <p class="field-err">{err}</p>}
        </div>
        <div class="dialog-foot">
          <Btn variant="ghost" onClick={() => d._resolve(isPrompt ? null : false)}>{d.cancelLabel || "Cancel"}</Btn>
          <Btn variant={d.danger ? "danger-solid" : "primary"} loading={busy} onClick={confirm}>{d.confirmLabel || "Confirm"}</Btn>
        </div>
      </div>
    </div>
  );
}
