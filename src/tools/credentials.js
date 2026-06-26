import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { CREDENTIALS_DIR } from "../config/paths.js";

const CRED_PATHS = [
  join(CREDENTIALS_DIR, "credentials.md"),
];

export function readCredentials(service) {
  for (const path of CRED_PATHS) {
    if (!existsSync(path)) continue;
    const content = readFileSync(path, "utf8");
    if (!service) return content;

    const lines = content.split("\n");
    let capturing = false;
    let result = [];
    for (const line of lines) {
      if (line.startsWith("## ") && line.toLowerCase().includes(service.toLowerCase())) {
        capturing = true;
        result.push(line);
        continue;
      }
      if (capturing) {
        if (line.startsWith("## ") && !line.toLowerCase().includes(service.toLowerCase())) {
          break;
        }
        result.push(line);
      }
    }
    if (result.length > 0) return result.join("\n").trim();
  }
  return `No credentials found for "${service}"`;
}
