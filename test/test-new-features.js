import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC_DIR = join(import.meta.dirname, "..", "src");

describe("context management", () => {
  let estimateTokens, compactMessages;

  before(async () => {
    const mod = await import("../src/ai/context.js");
    estimateTokens = mod.estimateTokens;
    compactMessages = mod.compactMessages;
  });

  it("estimateTokens returns roughly length/4 for strings", () => {
    const tokens = estimateTokens("hello world this is a test string");
    assert.ok(tokens > 5 && tokens < 15, "Expected ~8 tokens, got " + tokens);
  });

  it("estimateTokens handles arrays", () => {
    assert.ok(estimateTokens(["hello", "world"]) > 0);
  });

  it("estimateTokens counts images as 1000 tokens", () => {
    assert.equal(estimateTokens({ type: "image", source: { data: "abc" } }), 1000);
  });

  it("compactMessages does nothing when under target", () => {
    const messages = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi there" },
    ];
    const snapshot = JSON.stringify(messages);
    compactMessages(messages);
    assert.equal(JSON.stringify(messages), snapshot);
  });

  it("compactMessages compacts large tool results", () => {
    const bigResult = "x".repeat(100000);
    const messages = [];
    for (let i = 0; i < 100; i++) {
      messages.push({ role: "assistant", content: [{ type: "tool_use", id: "t" + i, name: "bash", input: {} }] });
      messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: "t" + i, content: bigResult }] });
    }
    messages.push({ role: "user", content: "final question" });
    const tokensBefore = messages.reduce((sum, m) => sum + (JSON.stringify(m.content).length / 4), 0);
    compactMessages(messages);
    const tokensAfter = messages.reduce((sum, m) => sum + (JSON.stringify(m.content).length / 4), 0);
    assert.ok(tokensAfter < tokensBefore, "Should compact: before=" + Math.round(tokensBefore) + " after=" + Math.round(tokensAfter));
  });

  it("compactMessages preserves at least 4 messages", () => {
    const messages = [];
    for (let i = 0; i < 100; i++) {
      messages.push({ role: "assistant", content: [{ type: "tool_use", id: "t" + i, name: "bash", input: {} }] });
      messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: "t" + i, content: "x".repeat(100000) }] });
    }
    compactMessages(messages);
    assert.ok(messages.length >= 4, "Should keep at least 4 messages, got " + messages.length);
  });
});

describe("streaming API", () => {
  it("agent.js uses messages.stream() not messages.create()", () => {
    const source = readFileSync(join(SRC_DIR, "ai", "agent.js"), "utf8");
    const createCalls = (source.match(/messages\.create\(/g) || []).length;
    const streamCalls = (source.match(/messages\.stream\(/g) || []).length;
    assert.equal(createCalls, 0, "agent.js should not use messages.create(), found " + createCalls);
    assert.ok(streamCalls >= 1, "agent.js should use messages.stream()");
  });

  it("subagent.js uses messages.stream() not messages.create()", () => {
    const source = readFileSync(join(SRC_DIR, "discord", "subagent.js"), "utf8");
    const createCalls = (source.match(/messages\.create\(/g) || []).length;
    const streamCalls = (source.match(/messages\.stream\(/g) || []).length;
    assert.equal(createCalls, 0, "subagent.js should not use messages.create(), found " + createCalls);
    assert.ok(streamCalls >= 1, "subagent.js should use messages.stream()");
  });
});

describe("background task queue", () => {
  it("agent.js uses startBgWork for background tasks", () => {
    const source = readFileSync(join(SRC_DIR, "ai", "agent.js"), "utf8");
    const calls = (source.match(/startBgWork\(/g) || []).length;
    assert.ok(calls >= 2, "Expected at least 2 startBgWork calls, found " + calls);
  });

  it("agent.js defines startBgWork with promise chaining", () => {
    const source = readFileSync(join(SRC_DIR, "ai", "agent.js"), "utf8");
    assert.ok(source.includes("bgTaskChain"), "Should use bgTaskChain for per-channel serialization");
    assert.ok(source.includes("function startBgWork"), "Should define startBgWork");
  });
});

describe("bash tool streaming", () => {
  it("uses spawn instead of exec for bash commands", () => {
    const source = readFileSync(join(SRC_DIR, "tools", "definitions.js"), "utf8");
    const bashCase = source.substring(source.indexOf('case "bash":'), source.indexOf('case "read_file":'));
    assert.ok(bashCase.includes("spawn("), "Bash tool should use spawn()");
  });

  it("bash timeout is 1800s default and max", () => {
    const source = readFileSync(join(SRC_DIR, "tools", "definitions.js"), "utf8");
    assert.ok(source.includes("1800000, 1800000"), "Bash timeout should be 1800000ms default and max");
  });

  it("no output truncation in bash tool", () => {
    const source = readFileSync(join(SRC_DIR, "tools", "definitions.js"), "utf8");
    const bashCase = source.substring(source.indexOf('case "bash":'), source.indexOf('case "read_file":'));
    assert.ok(!bashCase.includes(".substring("), "Bash tool should not truncate output");
  });
});

describe("no hard truncation", () => {
  it("read_file has no substring truncation", () => {
    const source = readFileSync(join(SRC_DIR, "tools", "definitions.js"), "utf8");
    const readCase = source.substring(source.indexOf('case "read_file":'), source.indexOf('case "write_file":'));
    assert.ok(!readCase.includes(".substring("), "read_file should not truncate");
  });

  it("list_files has no substring truncation", () => {
    const source = readFileSync(join(SRC_DIR, "tools", "definitions.js"), "utf8");
    const listCase = source.substring(source.indexOf('case "list_files":'), source.indexOf('case "read_discord_messages":'));
    assert.ok(!listCase.includes(".substring("), "list_files should not truncate");
  });

  it("web_fetch has no substring truncation", () => {
    const source = readFileSync(join(SRC_DIR, "tools", "web.js"), "utf8");
    assert.ok(!source.includes(".substring(0,"), "web.js should not truncate");
  });
});

describe("config matches OpenClaw", () => {
  let config;

  before(async () => {
    config = (await import("../src/config/index.js")).default;
  });

  it("maxTokens is 128000", () => {
    assert.equal(config.ai.maxTokens, 128000);
  });

  it("maxHistoryPerChannel is 100", () => {
    assert.equal(config.ai.maxHistoryPerChannel, 100);
  });
});

describe("history persistence", () => {
  it("agent.js has persistHistory and loadPersistedHistory", () => {
    const source = readFileSync(join(SRC_DIR, "ai", "agent.js"), "utf8");
    assert.ok(source.includes("HISTORY_DIR"), "Should define HISTORY_DIR");
    assert.ok(source.includes("persistHistory"), "Should have persistHistory");
    assert.ok(source.includes("loadPersistedHistory"), "Should have loadPersistedHistory");
  });

  it("ensureHistoryLoaded checks disk before Discord API", () => {
    const source = readFileSync(join(SRC_DIR, "ai", "agent.js"), "utf8");
    const fn = source.substring(source.indexOf("async function ensureHistoryLoaded"), source.indexOf("function getTrustLevel"));
    const diskPos = fn.indexOf("loadPersistedHistory");
    const discordPos = fn.indexOf("fetchRecentMessages");
    assert.ok(diskPos > 0 && discordPos > 0, "Should have both disk and Discord paths");
    assert.ok(diskPos < discordPos, "Should check disk BEFORE Discord API");
  });
});

describe("sub-agent features", () => {
  it("subagent.js imports and uses compactMessages", () => {
    const source = readFileSync(join(SRC_DIR, "discord", "subagent.js"), "utf8");
    assert.ok(source.includes("compactMessages"), "Should use compactMessages");
  });

  it("subagent.js sanitizes Discord output", () => {
    const source = readFileSync(join(SRC_DIR, "discord", "subagent.js"), "utf8");
    assert.ok(source.includes("sanitizeForDiscord"), "Should have sanitizeForDiscord");
    assert.ok(source.includes("REDACTED"), "Should use REDACTED markers");
  });

  it("subagent.js persists state with restricted permissions", () => {
    const source = readFileSync(join(SRC_DIR, "discord", "subagent.js"), "utf8");
    assert.ok(source.includes("persistAgent"), "Should persist agent state");
    assert.ok(source.includes("0o600"), "Should write with 0o600 permissions");
  });

  it("subagent.js has thread message routing and pending queue", () => {
    const source = readFileSync(join(SRC_DIR, "discord", "subagent.js"), "utf8");
    assert.ok(source.includes("injectThreadMessage"), "Should have injectThreadMessage");
    assert.ok(source.includes("pendingMessages"), "Should have pending message queue");
    assert.ok(source.includes("threadToAgent"), "Should map threads to agents");
  });
});

describe("file attachments", () => {
  it("client.js saves files to disk not inline", () => {
    const source = readFileSync(join(SRC_DIR, "discord", "client.js"), "utf8");
    assert.ok(source.includes("discord-uploads"), "Should save to /tmp/discord-uploads/");
    assert.ok(source.includes("writeFileSync(savePath"), "Should write files to disk");
  });

  it("client.js detects image format from magic bytes", () => {
    const source = readFileSync(join(SRC_DIR, "discord", "client.js"), "utf8");
    assert.ok(source.includes("0x89"), "Should detect PNG magic bytes");
    assert.ok(source.includes("0xFF"), "Should detect JPEG magic bytes");
  });

  it("client.js has dedup guard", () => {
    const source = readFileSync(join(SRC_DIR, "discord", "client.js"), "utf8");
    assert.ok(source.includes("hasResponded"), "Should check hasResponded");
  });

  it("history.js downloads attachments when reading messages", () => {
    const source = readFileSync(join(SRC_DIR, "discord", "history.js"), "utf8");
    assert.ok(source.includes("saveAttachments"), "Should download and save attachments");
    assert.ok(source.includes("discord-uploads"), "Should save to upload dir");
  });
});

describe("single response per message", () => {
  it("no Haiku ack in complex path", () => {
    const source = readFileSync(join(SRC_DIR, "ai", "agent.js"), "utf8");
    assert.ok(!source.includes("claude-haiku"), "Should not have Haiku ack");
    assert.ok(!source.includes("ackClient"), "Should not have ackClient");
  });

  it("no firstText separate reply", () => {
    const source = readFileSync(join(SRC_DIR, "ai", "agent.js"), "utf8");
    assert.ok(!source.includes("firstText"), "Should not send firstText");
  });

  it("sendBgResult suppressed when discord_send was used", () => {
    const source = readFileSync(join(SRC_DIR, "ai", "agent.js"), "utf8");
    assert.ok(source.includes("sentToChannel"), "Should track sentToChannel");
    assert.ok(source.includes("already sent via discord_send"), "Should suppress sendBgResult");
  });
});

describe("file write locking", () => {
  it("definitions.js imports file-lock module", () => {
    const source = readFileSync(join(SRC_DIR, "tools", "definitions.js"), "utf8");
    assert.ok(source.includes("acquireFileLock"), "Should import acquireFileLock");
    assert.ok(source.includes("getFileOwner"), "Should import getFileOwner");
  });

  it("write_file uses file lock", () => {
    const source = readFileSync(join(SRC_DIR, "tools", "definitions.js"), "utf8");
    const writeCase = source.substring(source.indexOf('case "write_file":'), source.indexOf('case "list_files":'));
    assert.ok(writeCase.includes("acquireFileLock"), "write_file should acquire lock");
    assert.ok(writeCase.includes("getFileOwner"), "write_file should check owner");
    assert.ok(writeCase.includes("release()"), "write_file should release lock");
  });

  it("agent.js passes callerAgent to executeTool", () => {
    const source = readFileSync(join(SRC_DIR, "ai", "agent.js"), "utf8");
    const calls = (source.match(/executeTool\(.*"main"\)/g) || []).length;
    assert.ok(calls >= 2, "agent.js should pass 'main' as callerAgent, found " + calls + " calls");
  });

  it("subagent.js passes agent.id to executeTool", () => {
    const source = readFileSync(join(SRC_DIR, "discord", "subagent.js"), "utf8");
    assert.ok(source.includes("executeTool(toolCall.name, toolCall.input, null, agent.id)"), "subagent should pass agent.id");
  });

  it("subagent.js clears file owners on completion", () => {
    const source = readFileSync(join(SRC_DIR, "discord", "subagent.js"), "utf8");
    assert.ok(source.includes("clearAllFileOwners"), "subagent should clear file owners");
    const clearCalls = (source.match(/clearAllFileOwners/g) || []).length;
    assert.ok(clearCalls >= 3, "Should clear on completed, failed, and cancelled, found " + clearCalls);
  });

  it("file-lock.js exists and exports correctly", () => {
    const source = readFileSync(join(SRC_DIR, "tools", "file-lock.js"), "utf8");
    assert.ok(source.includes("export function acquireFileLock"), "Should export acquireFileLock");
    assert.ok(source.includes("export function getFileOwner"), "Should export getFileOwner");
    assert.ok(source.includes("export function clearAllFileOwners"), "Should export clearAllFileOwners");
  });
});

describe("discord_send self-send blocking", () => {
  it("definitions.js has setBlockedChannelId", () => {
    const source = readFileSync(join(SRC_DIR, "tools", "definitions.js"), "utf8");
    assert.ok(source.includes("export function setBlockedChannelId"), "Should export setBlockedChannelId");
    assert.ok(source.includes("_blockedChannelId"), "Should use _blockedChannelId");
  });

  it("discord_send blocks sends to own channel during tool loop", () => {
    const source = readFileSync(join(SRC_DIR, "tools", "definitions.js"), "utf8");
    assert.ok(source.includes('callerAgent === "main" && input.action === "send" && _blockedChannelId'), "Should block main agent self-sends");
  });

  it("agent.js sets and clears blocked channel around tool loops", () => {
    const source = readFileSync(join(SRC_DIR, "ai", "agent.js"), "utf8");
    assert.ok(source.includes("setBlockedChannelId(taskMeta.channelId)"), "Should set blocked channel");
    assert.ok(source.includes("setBlockedChannelId(null)"), "Should clear blocked channel");
    assert.ok(source.includes("import { toolSchemas, executeTool, setPendingMessage, setBlockedChannelId }"), "Should import setBlockedChannelId");
  });
});
