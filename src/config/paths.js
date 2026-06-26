import { homedir } from "os";
import { join } from "path";

// The install directory is the git checkout (code only — safe to publish).
// AIROUTER_HOME holds everything private + stateful and lives OUTSIDE the install
// so the repo never contains secrets or user data. Default: ~/.aeroairouter.
// Override with the AIROUTER_HOME env var.
export const INSTALL_DIR = join(import.meta.dirname, "..", "..");

export const AIROUTER_HOME =
  process.env.AIROUTER_HOME && process.env.AIROUTER_HOME.trim()
    ? process.env.AIROUTER_HOME.trim()
    : join(homedir(), ".aeroairouter");

export const CONFIG_FILE = join(AIROUTER_HOME, "config.json");
export const SECRETS_FILE = join(AIROUTER_HOME, "secrets.env");
export const DATA_DIR = join(AIROUTER_HOME, "data");
export const PERSONA_DIR = join(AIROUTER_HOME, "persona");
export const CREDENTIALS_DIR = join(AIROUTER_HOME, "credentials");
export const PLUGINS_DIR = join(AIROUTER_HOME, "plugins");

// Example/template assets shipped inside the repo (used by install + first-run).
export const EXAMPLES_DIR = join(INSTALL_DIR, "examples");
