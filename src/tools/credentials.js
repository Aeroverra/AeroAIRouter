// Backing for the bot's get_credentials tool. Credentials are now managed in a
// structured store (credentials-store.js, editable from the config UI's Credentials
// tab); this thin wrapper keeps the original readCredentials(service) signature so
// definitions.js is unchanged. The store migrates the legacy credentials.md on first
// use and still falls back to it for anything not migrated.
import { lookupCredentials } from "./credentials-store.js";

export function readCredentials(service) {
  return lookupCredentials(service || "");
}
