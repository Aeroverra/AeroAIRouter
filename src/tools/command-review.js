import config from "../config/index.js";

// Best-effort safety floor (NOT a sandbox): commands matching these are denied
// unless BOTH a reviewer approves AND config.review.allowReviewerOverride is true.
// Override the list via config.review.dangerPatterns (array of regex source strings).
const DEFAULT_DANGER_PATTERNS = [
  "\\brm\\s+-[a-z]*r[a-z]*f|\\brm\\s+-[a-z]*f[a-z]*r", // rm -rf / -fr (any flag order)
  "\\brm\\s+-[rf].*\\s(/|~|\\$HOME)(\\s|$)",            // rm -r/-f targeting / ~ $HOME
  "\\b(mkfs|wipefs|blkdiscard)\\b",
  "\\bdd\\b[^\\n]*\\bof=",
  ">\\s*/dev/(sd|nvme|vd|mapper)",                       // overwrite a block device
  "\\bzfs\\s+destroy\\b",
  "\\bfind\\b[^\\n]*\\s-delete\\b",
  "\\bqm\\s+(destroy|stop|reset|shutdown)\\b",
  "\\bpct\\s+(destroy|stop|shutdown)\\b",
  "\\bpvesh\\s+(delete|set)\\b",
  "\\biptables\\s+-F\\b",
  "\\bsystemctl\\s+(stop|disable|mask)\\s+(pve|corosync|ceph)\\b",
  "\\bchmod\\s+-R\\s+777\\s+/",
  ":\\(\\)\\s*\\{[^}]*\\};:",                            // fork bomb
];

// Reviewers: (command) => null | { approved, reason, reviewer }.
// null = "no opinion" (fall through). Plugins register them at startup.
const reviewers = [];

export function registerCommandReviewer(fn) {
  if (typeof fn === "function") reviewers.push(fn);
}

export function clearCommandReviewers() {
  reviewers.length = 0;
}

function dangerRegexes() {
  const fromCfg =
    config.review && Array.isArray(config.review.dangerPatterns) && config.review.dangerPatterns.length
      ? config.review.dangerPatterns
      : DEFAULT_DANGER_PATTERNS;
  return fromCfg
    .map((p) => {
      try {
        return new RegExp(p, "i");
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

// Exported so plugins can reuse the same definition instead of duplicating it.
export function isDangerousCommand(command) {
  return dangerRegexes().some((r) => r.test(command));
}

// Synchronous so callers (e.g. the bash tool) can gate before spawning.
// Reviewer plugins that shell out should use a NON-shell exec (execFileSync).
export function reviewCommand(command) {
  const dangerous = isDangerousCommand(command);
  const allowOverride = !!(config.review && config.review.allowReviewerOverride);

  let approval = null;
  for (const r of reviewers) {
    let verdict = null;
    try {
      verdict = r(command);
    } catch (err) {
      console.error("[command-review] reviewer threw:", err.message);
      verdict = null;
    }
    if (verdict && verdict.approved === false) {
      return { approved: false, reason: verdict.reason || "blocked by reviewer", reviewer: verdict.reviewer || "reviewer" };
    }
    if (verdict && verdict.approved === true) {
      approval = { approved: true, reason: verdict.reason || "approved by reviewer", reviewer: verdict.reviewer || "reviewer" };
      break;
    }
  }

  // Dangerous commands are a hard floor: a reviewer can only override them when
  // the owner has explicitly enabled review.allowReviewerOverride.
  if (dangerous) {
    if (approval && allowOverride) return approval;
    return {
      approved: false,
      reason: approval
        ? "Command matches a dangerous pattern; reviewer approval ignored (review.allowReviewerOverride is off)"
        : "Command matches a dangerous pattern and was not approved",
      reviewer: "policy",
    };
  }

  if (approval) return approval;

  const policy = (config.review && config.review.policy) || "allow";
  if (policy === "deny") {
    return { approved: false, reason: "Default policy denies commands with no approving reviewer", reviewer: "policy" };
  }
  return { approved: true, reason: "No reviewer objected", reviewer: "policy" };
}
