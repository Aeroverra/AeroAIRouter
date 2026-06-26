import { readFileSync, writeFileSync, existsSync, renameSync, chmodSync, mkdirSync } from "fs";
import { join } from "path";
import { scryptSync, randomBytes, timingSafeEqual, createHash } from "crypto";
import { AIROUTER_HOME } from "../config/paths.js";

const AUTH_FILE = join(AIROUTER_HOME, "ui-auth.json");

function atomicWrite(file, content) {
  if (!existsSync(AIROUTER_HOME)) mkdirSync(AIROUTER_HOME, { recursive: true });
  const tmp = file + ".tmp-" + process.pid;
  writeFileSync(tmp, content, { encoding: "utf8", mode: 0o600 });
  try { chmodSync(tmp, 0o600); } catch {}
  renameSync(tmp, file);
}

export function passwordIsSet() {
  return existsSync(AUTH_FILE);
}

function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64);
  return salt.toString("hex") + ":" + hash.toString("hex");
}

function verifyHash(password, stored) {
  try {
    const [s, h] = stored.split(":");
    const salt = Buffer.from(s, "hex");
    const expected = Buffer.from(h, "hex");
    const actual = scryptSync(password, salt, expected.length);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

// Create (or reset) the admin password. Generates a session secret on first set.
export function setPassword(password) {
  if (!password || String(password).length < 6) {
    throw new Error("Password must be at least 6 characters");
  }
  let sessionSecret;
  if (existsSync(AUTH_FILE)) {
    try { sessionSecret = JSON.parse(readFileSync(AUTH_FILE, "utf8")).sessionSecret; } catch {}
  }
  if (!sessionSecret) sessionSecret = randomBytes(32).toString("hex");
  const data = {
    passwordHash: hashPassword(String(password)),
    sessionSecret,
    updatedAt: new Date().toISOString(),
  };
  atomicWrite(AUTH_FILE, JSON.stringify(data, null, 2) + "\n");
  return true;
}

export function verifyPassword(password) {
  if (!existsSync(AUTH_FILE)) return false;
  try {
    const data = JSON.parse(readFileSync(AUTH_FILE, "utf8"));
    return verifyHash(String(password || ""), data.passwordHash);
  } catch {
    return false;
  }
}

// Session secret for cookie signing; create a transient one if not set yet
// (only happens before setup, when no protected routes are reachable).
export function getSessionSecret() {
  if (existsSync(AUTH_FILE)) {
    try {
      const s = JSON.parse(readFileSync(AUTH_FILE, "utf8")).sessionSecret;
      if (s) return s;
    } catch {}
  }
  return createHash("sha256").update("aeroairouter-pre-setup-" + AIROUTER_HOME).digest("hex");
}
