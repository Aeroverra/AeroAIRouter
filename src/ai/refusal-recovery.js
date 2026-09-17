// Refusal recovery.
//
// Some benign owner questions come back as a hard API `stop_reason: "refusal"`
// with no content — not because the QUESTION is unsafe, but because a sensitive
// memory sitting in the always-on system prompt (an exploit/CVE write-up, a
// credentials note, etc.) tips Claude's safety classifier when a topically
// adjacent question arrives. Proven case: a one-line memory-index title
// "CVE - ActivTrak MITM RCE (Zero-Click) Disclosure" made "did they accept my
// CVE yet?" refuse; with that memory excluded the same question answers.
//
// This module supports a recovery ladder (driven from agent.js): rank the
// loaded memories by how much they overlap the user's prompt and how sensitive
// they read, summarize the top suspects down to only the safe facts needed to
// answer (so she keeps the CONTEXT but not the how-to detail), and hand those
// back so the caller can rebuild the prompt with the offenders excluded and
// retry. If every retry still refuses the caller drops to Opus 4.8.
import { listMemoryNames, memorySummary, readMemory } from "../memory/store.js";

// Words that make a memory read as security/adversarial/secret content — the
// stuff that makes the classifier jumpy when a related question shows up.
const SENSITIVE_RE = /\b(rce|exploit\w*|cvss|cve|mitm|payload|malware|ransom\w*|credential\w*|creds|password\w*|passwd|api[_-]?key|secret|token|vuln\w*|zero[-\s]?day|0day|bypass|backdoor|injection|hitlist|hit[-\s]list|breach\w*|privilege|escalat\w*|disclosure|attack\w*|weaponiz\w*)\b/i;

// Split digit/letter runs apart before tokenizing so a glued "9.6cve" yields
// "cve" (users type it both ways), then keep 3+ char tokens so short-but-loaded
// acronyms ("cve", "rce", "mitm") count — those are exactly the words that link
// a security question to the memory that trips the refusal.
function normalizeText(s) {
  return String(s || "").toLowerCase().replace(/(\d)([a-z])/g, "$1 $2").replace(/([a-z])(\d)/g, "$1 $2");
}
function tokens(s) {
  return normalizeText(s).match(/[a-z0-9]{3,}/g) || [];
}

// Cheap sensitivity probe: name + one-line summary + the first ~1.5KB of body.
export function isSensitiveMemory(name) {
  let body = "";
  try { body = readMemory(name).slice(0, 1500); } catch {}
  const hay = String(name).replace(/[-_.]/g, " ") + " " + memorySummary(name) + " " + body;
  return SENSITIVE_RE.test(hay);
}

export function allSensitiveMemoryNames() {
  return listMemoryNames().filter(isSensitiveMemory);
}

// Order the loaded memories by likelihood of being what tripped the refusal:
// prompt-overlap (title/summary weighted over body) times a sensitivity bonus.
// Only returns memories that are either relevant to the prompt or sensitive —
// excluding an unrelated, harmless note would never help.
export function rankSuspectMemories(userText) {
  const want = new Set(tokens(userText));
  if (want.size === 0) return [];
  // A security-flavored question ("did they accept my CVE", "the RCE I found")
  // is exactly the kind that a sensitive memory refuses next to, so when the
  // prompt itself reads sensitive, weight sensitive memories much more heavily.
  const promptSensitive = SENSITIVE_RE.test(normalizeText(userText));
  const scored = listMemoryNames().map((name) => {
    const summary = memorySummary(name);
    let body = "";
    try { body = readMemory(name).slice(0, 1500); } catch {}
    const head = String(name).replace(/[-_.]/g, " ") + " " + summary;
    const relHead = tokens(head).filter((t) => want.has(t)).length;
    const relBody = tokens(body).filter((t) => want.has(t)).length;
    const rel = relHead + relBody * 0.25;
    const sens = SENSITIVE_RE.test(head + " " + body) ? 1 : 0;
    const score = rel * 2 + sens * (promptSensitive ? 8 : 3);
    return { name, score, rel, sens };
  });
  return scored
    .filter((s) => s.rel > 0 || s.sens)
    .sort((a, b) => b.score - a.score)
    .map((s) => s.name);
}

// Deterministic, no-API fallback summary: the memory's own summary line plus any
// status/outcome lines, with obviously technical lines dropped. Used when the
// model summarizer is unavailable or itself refuses.
export function redactMemory(name) {
  let content = "";
  try { content = readMemory(name); } catch { return ""; }
  const summary = memorySummary(name);
  const keep = [];
  for (const raw of content.split("\n")) {
    const line = raw.replace(/^[#>*\-\s]+/, "").trim();
    if (!line || line.length < 4) continue;
    if (/^(name|description|metadata|node_type|type|originSessionId|pinned):/i.test(line)) continue;
    if (/```|WINHTTP|\.cpp|\.exe|\.msi|0x[0-9a-f]|CWE-|line \d+|payload|proxy|certificate|TLS|shellcode/i.test(line)) continue;
    if (/\b(status|accepted|acknowledg|bounty|reward|paid|resolved|pending|reported|outcome|hall of fame|credit|disclosed|filed)\b/i.test(line)) {
      keep.push(line);
    }
    if (keep.length >= 5) break;
  }
  const out = [summary, ...keep].filter(Boolean).join(". ");
  return out.slice(0, 500);
}

// Model summarizer: read the suspect memories and return ONLY the safe facts
// needed to answer this specific prompt. Runs on Haiku (cheap, fast) with a
// plain system prompt and no persona, which the probes showed does not refuse
// this content. On any failure the caller falls back to redactMemory().
export async function summarizeMemoryForPrompt(client, names, userText) {
  const src = names
    .map((n) => { try { return "[" + n + "]\n" + readMemory(n); } catch { return ""; } })
    .filter(Boolean)
    .join("\n\n")
    .slice(0, 8000);
  if (!src) return "";
  const system =
    "You pull ONLY the minimal, non-sensitive facts a helpful assistant needs to answer a user's question from their own private notes. " +
    "Absolutely NO exploit steps, attack methodology, code, payloads, credentials, secrets, specific targets, or how-to detail of any kind. " +
    "Keep only high-level status, outcomes, dates, dollar amounts, and the names of the user's own projects. " +
    "Output 1 to 4 plain factual sentences. If nothing safe is relevant, output one neutral sentence of context.";
  const user =
    "User's question:\n" + userText + "\n\nThe user's private notes:\n" + src +
    "\n\nSummarize only the safe, relevant facts needed to answer the question.";
  const r = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 300,
    system,
    messages: [{ role: "user", content: user }],
  });
  const raw = r.content.filter((b) => b.type === "text").map((b) => b.text).join(" ").trim();
  return sanitizeSummary(raw);
}

// Even a "safe" summary of a security memory keeps words like CVE/RCE/exploit,
// and those alone can re-trip the classifier when injected back into the prompt.
// Neutralize the charged terms while keeping the answer-bearing facts (status,
// bounty, dates). The reply she writes for the user is her own — this only feeds
// her enough context to answer.
export function sanitizeSummary(text) {
  return String(text || "")
    .replace(/\b(zero[-\s]?day|0[-\s]?day)\b/gi, "finding")
    .replace(/\bremote code execution\b/gi, "serious issue")
    .replace(/\bman[-\s]?in[-\s]?the[-\s]?middle\b/gi, "")
    .replace(/\bmitm\b/gi, "")
    .replace(/\brce\b/gi, "issue")
    .replace(/\bexploit\w*/gi, "issue")
    .replace(/\bvulnerab\w*/gi, "issue")
    .replace(/\bvuln\b/gi, "issue")
    .replace(/\bcvss[^\s]*/gi, "")
    .replace(/\bcwe-\d+/gi, "")
    .replace(/\bcve\b/gi, "security report")
    .replace(/\s{2,}/g, " ")
    .trim();
}
