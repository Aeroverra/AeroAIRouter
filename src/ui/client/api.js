// Tiny fetch wrapper. CSRF token is attached to every mutating request.
let csrf = null;
export function setCsrf(t) { csrf = t; }
export function getCsrf() { return csrf; }

export async function api(method, url, body) {
  const opts = { method, headers: {} };
  if (body !== undefined) { opts.headers["Content-Type"] = "application/json"; opts.body = JSON.stringify(body); }
  if (method !== "GET" && csrf) opts.headers["X-CSRF-Token"] = csrf;
  const r = await fetch(url, opts);
  let data = null;
  try { data = await r.json(); } catch {}
  if (!r.ok) throw new Error((data && data.error) || ("HTTP " + r.status));
  return data;
}
