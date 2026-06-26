import { readFileSync, existsSync } from "fs";
import { SECRETS_FILE } from "./paths.js";

// Parse a dotenv-style secrets file into process.env WITHOUT clobbering values
// that are already set in the real environment (process env wins — it has higher
// precedence). Supports `KEY=value`, optional `export KEY=value`, quoted values,
// `#` comments, and blank lines. Secrets never live in config.json or in source.
export function loadSecrets() {
  if (!existsSync(SECRETS_FILE)) return;

  const raw = readFileSync(SECRETS_FILE, "utf8");
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const withoutExport = trimmed.startsWith("export ")
      ? trimmed.slice(7).trim()
      : trimmed;

    const eq = withoutExport.indexOf("=");
    if (eq === -1) continue;

    const key = withoutExport.slice(0, eq).trim();
    if (!key) continue;

    let value = withoutExport.slice(eq + 1).trim();
    // Strip a single matching pair of surrounding quotes.
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    // Real environment variables take precedence over the file.
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}
