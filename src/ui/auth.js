import { readFileSync, writeFileSync, existsSync, renameSync, chmodSync, mkdirSync } from "fs";
import { join } from "path";
import { scryptSync, randomBytes, timingSafeEqual } from "crypto";
import { AIROUTER_HOME } from "../config/paths.js";

const AUTH_FILE = join(AIROUTER_HOME, "ui-auth.json");
const SECRET_FILE = join(AIROUTER_HOME, "session-secret");
const MIN_PASSWORD = 8;

function atomicWrite(file, content) {
  if (!existsSync(AIROUTER_HOME)) mkdirSync(AIROUTER_HOME, { recursive: true });
  const tmp = file + ".tmp-" + randomBytes(6).toString("hex");
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

export function setPassword(password) {
  if (!password || String(password).length < MIN_PASSWORD) {
    throw new Error("Password must be at least " + MIN_PASSWORD + " characters");
  }
  atomicWrite(
    AUTH_FILE,
    JSON.stringify({ passwordHash: hashPassword(String(password)), updatedAt: new Date().toISOString() }, null, 2) + "\n"
  );
  return true;
}

export function verifyPassword(password) {
  if (!existsSync(AUTH_FILE)) return false;
  try {
    return verifyHash(String(password || ""), JSON.parse(readFileSync(AUTH_FILE, "utf8")).passwordHash);
  } catch {
    return false;
  }
}

// A random, persisted session-signing secret — created eagerly at startup,
// independent of whether a password is set. Never derived from a guessable value
// (a deterministic secret would let anyone forge an authenticated cookie).
export function getSessionSecret() {
  if (existsSync(SECRET_FILE)) {
    try {
      const s = readFileSync(SECRET_FILE, "utf8").trim();
      if (s) return s;
    } catch {}
  }
  const secret = randomBytes(32).toString("hex");
  atomicWrite(SECRET_FILE, secret + "\n");
  return secret;
}

// Rotate the signing secret — invalidates all existing sessions on next load.
// The caller must restart the UI process for the new secret to take effect.
export function rotateSessionSecret() {
  const secret = randomBytes(32).toString("hex");
  atomicWrite(SECRET_FILE, secret + "\n");
  return secret;
}
