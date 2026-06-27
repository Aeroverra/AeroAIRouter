#!/usr/bin/env node
// One-time helper to obtain a Google OAuth refresh token for the Gmail plugin.
// Zero dependencies (Node's http + fetch). Runs a local loopback redirect.
//
// Prereqs:
//   1. Google Cloud Console → APIs & Services → enable the Gmail API.
//   2. OAuth consent screen → add yourself as a Test user (External, Testing).
//   3. Credentials → Create OAuth client ID → type "Desktop app".
//      (Desktop clients accept http://localhost redirects.)
//
// Usage:
//   GOOGLE_CLIENT_ID=xxx GOOGLE_CLIENT_SECRET=yyy node scripts/get-google-refresh-token.mjs
//
// It prints an authorization URL. Open it, approve, and the token is captured
// on the loopback redirect and printed. Paste it into the Gmail plugin as
// GOOGLE_REFRESH_TOKEN (with the same client id + secret).
import http from "http";

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || "";
const PORT = Number(process.env.PORT || 53682);
const REDIRECT = "http://localhost:" + PORT;
const SCOPES = [
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.send",
];

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error("Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in the environment first.");
  process.exit(1);
}

const authUrl =
  "https://accounts.google.com/o/oauth2/v2/auth?" +
  new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT,
    response_type: "code",
    scope: SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent",
  }).toString();

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, REDIRECT);
  const code = url.searchParams.get("code");
  if (!code) { res.writeHead(400); res.end("No code in request."); return; }
  try {
    const r = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code, client_id: CLIENT_ID, client_secret: CLIENT_SECRET,
        redirect_uri: REDIRECT, grant_type: "authorization_code",
      }),
    });
    const d = await r.json();
    if (!r.ok || !d.refresh_token) {
      res.writeHead(500); res.end("Token exchange failed — see console.");
      console.error("\nFailed:", JSON.stringify(d, null, 2));
      console.error("(If there's no refresh_token, revoke prior access at myaccount.google.com/permissions and retry.)");
      process.exit(1);
    }
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("Success! Refresh token captured — return to your terminal. You can close this tab.");
    console.log("\n=== GOOGLE_REFRESH_TOKEN ===\n" + d.refresh_token + "\n");
    console.log("Paste it into the Gmail plugin (with the same client id + secret).");
    process.exit(0);
  } catch (err) {
    res.writeHead(500); res.end("Error — see console.");
    console.error(err);
    process.exit(1);
  }
});

server.listen(PORT, () => {
  console.log("\n1) Open this URL in a browser signed into the target Google account:\n");
  console.log("   " + authUrl + "\n");
  console.log("2) Approve access. Waiting for the redirect on " + REDIRECT + " …");
});
