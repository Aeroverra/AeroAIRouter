import { createServer } from "http";
import { request as httpsRequest } from "https";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { execFileSync } from "child_process";
import config from "../config/index.js";
import { emojiSuffix } from "../persona.js";

const CHECK_FILE = join(config.dataDir, "api-health-state.json");
const CLAUDE_BIN = process.env.CLAUDE_CLI || join(process.env.HOME || "", ".npm-global/bin/claude");

function loadCurrentHeaders() {
  try {
    const state = JSON.parse(readFileSync(CHECK_FILE, "utf8"));
    return state;
  } catch {
    return null;
  }
}

function saveState(state) {
  writeFileSync(CHECK_FILE, JSON.stringify(state, null, 2), "utf8");
}

export async function runApiHealthCheck() {
  return new Promise((resolve) => {
    const captured = { headers: null, query: null, betaFlags: null };

    const server = createServer((req, res) => {
      if (req.method === "POST" && req.url.includes("/v1/messages")) {
        const url = new URL(req.url, "http://localhost");
        captured.query = Object.fromEntries(url.searchParams);
        captured.headers = {
          "anthropic-beta": req.headers["anthropic-beta"] || "",
          "anthropic-version": req.headers["anthropic-version"] || "",
          "anthropic-dangerous-direct-browser-access":
            req.headers["anthropic-dangerous-direct-browser-access"] || "",
          "x-app": req.headers["x-app"] || "",
          "user-agent": req.headers["user-agent"] || "",
        };
        captured.betaFlags = (req.headers["anthropic-beta"] || "")
          .split(",")
          .map((f) => f.trim())
          .filter(Boolean);

        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          try {
            const parsed = JSON.parse(body);
            const systemBlocks = parsed.system || [];
            const billingBlock = systemBlocks.find(
              (s) => typeof s === "object" && s.text && s.text.includes("x-anthropic-billing-header")
            );
            captured.billingHeader = billingBlock ? billingBlock.text : null;
            captured.metadata = parsed.metadata || null;
          } catch {}

          const fakeResp = JSON.stringify({
            id: "msg_fake",
            type: "message",
            role: "assistant",
            content: [{ type: "text", text: "health check" }],
            model: "claude-sonnet-4-6",
            stop_reason: "end_turn",
            usage: { input_tokens: 10, output_tokens: 5 },
          });
          res.writeHead(200, { "content-type": "application/json" });
          res.end(fakeResp);
          server.close();
        });
      } else {
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
      }
    });

    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;

      try {
        execFileSync(CLAUDE_BIN, ["--print", "--model", "sonnet", "-p", "Say: ok"], {
          timeout: 30000,
          env: {
            ...process.env,
            ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
          },
          stdio: "pipe",
        });
      } catch {}

      setTimeout(() => {
        server.close();

        const previous = loadCurrentHeaders();
        const now = new Date().toISOString();
        const current = {
          ...captured,
          checkedAt: now,
        };

        let changes = [];
        if (previous) {
          if (previous.headers?.["anthropic-beta"] !== captured.headers?.["anthropic-beta"]) {
            changes.push(`anthropic-beta changed: "${previous.headers?.["anthropic-beta"]}" -> "${captured.headers?.["anthropic-beta"]}"`);
          }
          if (previous.headers?.["anthropic-version"] !== captured.headers?.["anthropic-version"]) {
            changes.push(`anthropic-version changed: "${previous.headers?.["anthropic-version"]}" -> "${captured.headers?.["anthropic-version"]}"`);
          }
          if (previous.headers?.["user-agent"] !== captured.headers?.["user-agent"]) {
            changes.push(`user-agent changed: "${previous.headers?.["user-agent"]}" -> "${captured.headers?.["user-agent"]}"`);
          }
          if (JSON.stringify(previous.query) !== JSON.stringify(captured.query)) {
            changes.push(`query params changed: ${JSON.stringify(previous.query)} -> ${JSON.stringify(captured.query)}`);
          }
          if (previous.billingHeader !== captured.billingHeader) {
            changes.push(`billing header changed: "${previous.billingHeader}" -> "${captured.billingHeader}"`);
          }
        }

        saveState(current);

        resolve({
          current,
          previous,
          changes,
          isFirstRun: !previous,
        });
      }, 2000);
    });
  });
}

export function formatHealthReport(result) {
  if (result.isFirstRun) {
    return [
      "Weekly API health check: baseline captured" + emojiSuffix(),
      "",
      `Beta flags: ${result.current.betaFlags?.join(", ") || "none"}`,
      `Version: ${result.current.headers?.["anthropic-version"] || "unknown"}`,
      `User-Agent: ${result.current.headers?.["user-agent"] || "unknown"}`,
      "",
      "I will compare against this next week.",
    ].join("\n");
  }

  if (result.changes.length === 0) {
    return [
      "Weekly API health check: all clear" + emojiSuffix(),
      "",
      "No changes detected in Claude CLI API headers/params since last check.",
      `Last checked: ${result.previous?.checkedAt || "unknown"}`,
    ].join("\n");
  }

  const prompt = [
    "Update the OAuth client headers in src/ai/client.js to match the new headers",
    "the Claude CLI is now using. Run the health check proxy to capture the exact values.",
    "Changes detected:",
    ...result.changes.map((c) => `- ${c}`),
  ].join("\n");

  return [
    "Weekly API health check: UPDATE NEEDED" + emojiSuffix(),
    "",
    `${result.changes.length} change(s) detected:`,
    ...result.changes.map((c) => `- ${c}`),
    "",
    "To update the client, run:",
    "```",
    prompt,
    "```",
  ].join("\n");
}
