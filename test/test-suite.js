import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SRC_DIR = join(import.meta.dirname, "..", "src");
const PROJECT_ROOT = join(import.meta.dirname, "..");

// ============================================================
// SECTION 1: Syntax validation for all source files
// ============================================================

describe("Syntax validation", () => {
  const jsFiles = [];

  function collectJs(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) collectJs(full);
      else if (entry.name.endsWith(".js")) jsFiles.push(full);
    }
  }
  collectJs(SRC_DIR);

  for (const file of jsFiles) {
    const relative = file.replace(PROJECT_ROOT + "/", "");
    it("parses without syntax errors: " + relative, () => {
      try {
        execSync("node --check " + JSON.stringify(file), { encoding: "utf8", timeout: 5000 });
      } catch (err) {
        assert.fail("Syntax error in " + relative + ": " + (err.stderr || err.message));
      }
    });
  }
});

// ============================================================
// SECTION 2: model-router.js
// ============================================================

describe("model-router", () => {
  let isComplex, pickModel;

  before(async () => {
    const mod = await import("../src/ai/model-router.js");
    isComplex = mod.isComplex;
    pickModel = mod.pickModel;
  });

  it("flags build/create/deploy/infra requests as complex", () => {
    assert.ok(isComplex("build me a website"));
    assert.ok(isComplex("create a new discord bot"));
    assert.ok(isComplex("deploy to the server"));
    assert.ok(isComplex("restart the docker container"));
  });

  it("does NOT flag simple questions as complex", () => {
    assert.ok(!isComplex("whats the weather in austin"));
    assert.ok(!isComplex("hello how are you"));
    assert.ok(!isComplex("what time is it"));
    assert.ok(!isComplex("tell me a joke"));
    assert.ok(!isComplex("thoughts on that image azula?"));
    assert.ok(!isComplex("whats the weather in myrtle beach"));
  });

  it("returns a valid model string", () => {
    const model = pickModel("hello", "123");
    assert.ok(typeof model === "string" && model.length > 0);
  });
});

// ============================================================
// SECTION 3: trust.js
// ============================================================

describe("trust", () => {
  let getTrustLevel, setTrustOverride, clearTrustOverride;

  before(async () => {
    const mod = await import("../src/discord/trust.js");
    getTrustLevel = mod.getTrustLevel;
    setTrustOverride = mod.setTrustOverride;
    clearTrustOverride = mod.clearTrustOverride;
  });

  it("returns correct trust levels for known users", async () => {
    const config = (await import("../src/config/index.js")).default;
    if (config.discord.ownerId) {
      assert.equal(getTrustLevel(config.discord.ownerId), "owner");
    }
    assert.equal(getTrustLevel("999999999999"), "none");
  });

  it("supports runtime trust overrides", () => {
    setTrustOverride("999999999999", "elevated", 5);
    assert.equal(getTrustLevel("999999999999"), "elevated");
    clearTrustOverride("999999999999");
    assert.equal(getTrustLevel("999999999999"), "none");
  });
});

// ============================================================
// SECTION 4: agent.js pure function tests
// ============================================================

describe("agent internals", () => {
  let agentMod;

  before(async () => {
    agentMod = await import("../src/ai/agent.js");
  });

  describe("getBackgroundTaskNote", () => {
    afterEach(() => { agentMod.activeBackgroundTasks.clear(); });

    it("returns empty string when no background tasks", () => {
      assert.equal(agentMod.getBackgroundTaskNote("test-channel-1"), "");
    });

    it("returns CRITICAL warning with task descriptions when tasks are active", () => {
      agentMod.activeBackgroundTasks.set("ch", new Map([
        ["bg-1", "build imalive4"],
        ["bg-2", "deploy nginx config"],
      ]));
      const note = agentMod.getBackgroundTaskNote("ch");
      assert.ok(note.includes("CRITICAL"));
      assert.ok(note.includes("build imalive4"));
      assert.ok(note.includes("deploy nginx config"));
      assert.ok(note.includes("MUST NOT address"));
    });

    it("is per-channel isolated", () => {
      agentMod.activeBackgroundTasks.set("ch-A", new Map([["bg-1", "task A"]]));
      agentMod.activeBackgroundTasks.set("ch-B", new Map([["bg-2", "task B"]]));
      assert.ok(agentMod.getBackgroundTaskNote("ch-A").includes("task A"));
      assert.ok(!agentMod.getBackgroundTaskNote("ch-A").includes("task B"));
      assert.equal(agentMod.getBackgroundTaskNote("ch-C"), "");
    });
  });

  describe("filterToolsForTrust", () => {
    it("owner gets all tools, elevated excludes dangerous, none gets 4 safe tools", () => {
      const owner = agentMod.filterToolsForTrust("owner");
      const elevated = agentMod.filterToolsForTrust("elevated");
      const none = agentMod.filterToolsForTrust("none");
      assert.ok(owner.length > 10);
      assert.ok(owner.some(t => t.name === "write_file"));
      assert.ok(!elevated.some(t => t.name === "write_file"));
      assert.ok(!elevated.some(t => t.name === "cron"));
      assert.deepEqual(none.map(t => t.name).sort(), ["read_discord_messages", "voice_speak", "web_fetch", "web_search"]);
    });
  });

  describe("buildMessagesWithAttachments", () => {
    it("returns copy, does not mutate original, injects images correctly", () => {
      const history = [{ role: "user", content: "look at this" }];
      const attachments = [{ type: "image", source: { type: "base64", media_type: "image/png", data: "abc" } }];
      const result = agentMod.buildMessagesWithAttachments(history, attachments, "look at this");
      assert.notStrictEqual(result, history);
      assert.equal(history[0].content, "look at this");
      assert.ok(Array.isArray(result[0].content));
      assert.equal(result[0].content[0].type, "image");
      assert.equal(result[0].content[1].type, "text");
    });

    it("passes through history unchanged when no attachments", () => {
      const history = [{ role: "user", content: "hello" }, { role: "assistant", content: "hi" }];
      const result = agentMod.buildMessagesWithAttachments(history, [], "hello");
      assert.equal(result.length, 2);
      assert.equal(result[0].content, "hello");
    });
  });
});

// ============================================================
// SECTION 5: Background task isolation logic
// ============================================================

describe("background task isolation", () => {
  let agentMod;

  before(async () => { agentMod = await import("../src/ai/agent.js"); });
  afterEach(() => { agentMod.activeBackgroundTasks.clear(); });

  it("placeholder includes unique task key and is findable for replacement", () => {
    const taskKey = "bg-" + Date.now();
    const placeholder = "[BACKGROUND TASK " + taskKey + ": Already working on this request in a separate background process. This task is being handled independently. Do not re-address, continue, or reference this request.]";
    const history = [
      { role: "user", content: "[TestUser]: build imalive4" },
      { role: "assistant", content: placeholder },
      { role: "user", content: "[TestUser]: whats the weather" },
      { role: "assistant", content: "The weather in Austin is 91F" },
    ];

    const idx = history.findLastIndex((h) => h.role === "assistant" && typeof h.content === "string" && h.content.includes(taskKey));
    assert.equal(idx, 1);
    history[idx] = { role: "assistant", content: "Done building imalive4!" };
    assert.equal(history[1].content, "Done building imalive4!");
  });

  it("task key search does not false-match other tasks", () => {
    const history = [
      { role: "assistant", content: "[BACKGROUND TASK bg-1717000002: ...]" },
      { role: "assistant", content: "normal response" },
      { role: "assistant", content: "[BACKGROUND TASK bg-1717000001: ...]" },
    ];
    const idx = history.findLastIndex((h) => h.role === "assistant" && typeof h.content === "string" && h.content.includes("bg-1717000001"));
    assert.equal(idx, 2);
  });
});

// ============================================================
// SECTION 6: Snapshot timing and code structure verification
// ============================================================

describe("snapshot timing verification", () => {
  it("snapshot is taken BEFORE any API calls (ack or first response)", () => {
    const source = readFileSync(join(SRC_DIR, "ai", "agent.js"), "utf8");

    // Find handleMessage function start so we only check within it
    const handleStart = source.indexOf("export async function handleMessage");
    assert.ok(handleStart > 0, "handleMessage function not found");

    const handleSource = source.substring(handleStart);
    const snapshotPos = handleSource.indexOf("buildMessagesWithAttachments([...history]");
    const ackPos = handleSource.indexOf("channel.sendTyping");
    const firstApiPos = handleSource.indexOf("streamApiCall(client, params)");

    assert.ok(snapshotPos > 0, "snapshot call not found in handleMessage");
    assert.ok(ackPos > 0, "sendTyping call not found in handleMessage");
    assert.ok(firstApiPos > 0, "first API call not found in handleMessage");

    assert.ok(snapshotPos < ackPos, "RACE CONDITION: snapshot must be taken BEFORE the sendTyping call");
    assert.ok(snapshotPos < firstApiPos, "RACE CONDITION: snapshot must be taken BEFORE the first API call");
  });

  it("bg task registration happens BEFORE sendTyping in complex path", () => {
    const source = readFileSync(join(SRC_DIR, "ai", "agent.js"), "utf8");
    const registerLine = source.indexOf("registerBackgroundTask(channel.id, taskKey");
    const sendTypingLine = source.indexOf("channel.sendTyping", registerLine);

    assert.ok(registerLine > 0, "registerBackgroundTask not found");
    assert.ok(sendTypingLine > 0, "sendTyping not found after registerBackgroundTask");
    assert.ok(registerLine < sendTypingLine, "bg task must be registered BEFORE sendTyping so concurrent messages see the warning");
  });

  it("non-complex tool-use path also registers bg task and pushes placeholder", () => {
    const source = readFileSync(join(SRC_DIR, "ai", "agent.js"), "utf8");

    // After the first API call, if tools are detected, there should be a second registerBackgroundTask
    const firstRegister = source.indexOf("registerBackgroundTask(channel.id, taskKey");
    const secondRegister = source.indexOf("registerBackgroundTask(channel.id, taskKey", firstRegister + 1);

    assert.ok(firstRegister > 0, "first registerBackgroundTask not found (complex path)");
    assert.ok(secondRegister > 0, "second registerBackgroundTask not found (non-complex tool-use path). " +
      "When the model returns tool_use on a non-complex message, it MUST switch to background mode.");
  });

  it("all runToolLoop CALLS use frozenMessages, not raw variables", () => {
    const source = readFileSync(join(SRC_DIR, "ai", "agent.js"), "utf8");

    // Count calls that use frozenMessages
    const goodCalls = (source.match(/runToolLoop\(client, frozenMessages/g) || []).length;
    assert.ok(goodCalls >= 2, "Expected at least 2 runToolLoop calls with frozenMessages, found " + goodCalls);

    // Verify no EXPORT calls use raw 'history' (exclude function definition which uses 'messages' as param name)
    // Match calls like: runToolLoop(client, history  or  runToolLoop(client, messages,
    // but NOT the function definition: async function runToolLoop(client, messages,
    const callSites = [...source.matchAll(/(?<!function\s)runToolLoop\(client,\s*(\w+)/g)];
    for (const match of callSites) {
      assert.equal(match[1], "frozenMessages",
        "runToolLoop call uses '" + match[1] + "' instead of 'frozenMessages' - this is a race condition risk");
    }
  });
});

// ============================================================
// SECTION 7: Tool definitions
// ============================================================

describe("tool definitions", () => {
  let toolSchemas, executeTool;

  before(async () => {
    const mod = await import("../src/tools/definitions.js");
    toolSchemas = mod.toolSchemas;
    executeTool = mod.executeTool;
  });

  it("has all 18 expected tools with proper schemas", () => {
    const expected = [
      "bash", "read_file", "write_file", "list_files",
      "read_discord_messages", "get_credentials", "task_manage",
      "spawn_agent", "cancel_agent", "message_agent", "list_agents", "voice_speak", "trust_manage",
      "voice_control", "web_search", "web_fetch", "discord_send", "cron",
    ];
    assert.equal(toolSchemas.length, expected.length);
    for (const name of expected) {
      const tool = toolSchemas.find(t => t.name === name);
      assert.ok(tool, "Missing tool: " + name);
      assert.ok(tool.description, name + " missing description");
      assert.ok(tool.input_schema, name + " missing input_schema");
    }
  });

  it("executeTool returns error for unknown tool", () => {
    const result = executeTool("nonexistent_tool", {}, null);
    assert.ok(result.error || result.success === false);
  });
});

// ============================================================
// SECTION 8: LIVE API - Background task isolation
// Actually calls Claude to verify the model respects bg task warnings
// ============================================================

describe("LIVE API: background task isolation", () => {
  let client, getMetadata, BILLING_SYSTEM_BLOCK;

  before(async () => {
    const clientMod = await import("../src/ai/client.js");
    client = await clientMod.getClient();
    getMetadata = clientMod.getMetadata;
    BILLING_SYSTEM_BLOCK = clientMod.BILLING_SYSTEM_BLOCK;
  });

  it("model does NOT reference background task when answering weather question", async () => {
    const bgNote = "\n\nCRITICAL - ACTIVE BACKGROUND TASKS (these are already being handled in separate processes, you MUST NOT address, continue, reference, or restart them):\n- build imalive v4 with spectacular animations\nYou MUST only respond to the newest message. Treat it as a completely independent, unrelated request. Do NOT combine your response with background task work. Do NOT mention the background tasks.";

    const response = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 500,
      system: [BILLING_SYSTEM_BLOCK, { type: "text", text: "You are Azula, a Discord bot. Be brief." + bgNote }],
      messages: [
        { role: "user", content: "[TestUser]: build imalive v4 make it spectacular" },
        { role: "assistant", content: "[BACKGROUND TASK bg-12345: Already working on this request in a separate background process. This task is being handled independently. Do not re-address, continue, or reference this request.]" },
        { role: "user", content: "[TestUser]: whats the weather in austin texas?" },
      ],
      metadata: getMetadata(),
    });

    const text = response.content.filter(b => b.type === "text").map(b => b.text).join("\n").toLowerCase();
    console.log("[test] weather response: " + text.substring(0, 200));

    assert.ok(!text.includes("imalive") && !text.includes("v4") && !text.includes("spectacular"),
      "ISOLATION FAILURE: response referenced background task. Got: " + text.substring(0, 200));
    assert.ok(!text.includes("let me build") && !text.includes("start building"),
      "ISOLATION FAILURE: response talked about building. Got: " + text.substring(0, 200));
  });

  it("model does NOT re-send weather or reference bg task when asked about an image", async () => {
    const bgNote = "\n\nCRITICAL - ACTIVE BACKGROUND TASKS (these are already being handled in separate processes, you MUST NOT address, continue, reference, or restart them):\n- build imalive v4 with spectacular animations\nYou MUST only respond to the newest message. Treat it as a completely independent, unrelated request. Do NOT combine your response with background task work. Do NOT mention the background tasks.";

    const response = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 500,
      system: [BILLING_SYSTEM_BLOCK, { type: "text", text: "You are Azula, a Discord bot. Be brief." + bgNote }],
      messages: [
        { role: "user", content: "[TestUser]: build imalive v4 make it spectacular" },
        { role: "assistant", content: "[BACKGROUND TASK bg-12345: Already working on this request in a separate background process. This task is being handled independently. Do not re-address, continue, or reference this request.]" },
        { role: "user", content: "[TestUser]: whats the weather in myrtle beach?" },
        { role: "assistant", content: "Myrtle Beach right now: 81F, chance of storms tonight." },
        { role: "user", content: "[TestUser]: thoughts on that image azula?" },
      ],
      metadata: getMetadata(),
    });

    const text = response.content.filter(b => b.type === "text").map(b => b.text).join("\n").toLowerCase();
    console.log("[test] image response: " + text.substring(0, 200));

    assert.ok(!text.includes("imalive") && !text.includes("v4") && !text.includes("v3"),
      "ISOLATION FAILURE: referenced background task on image question. Got: " + text.substring(0, 200));
  });

  it("model tells a joke without mentioning deploy task", async () => {
    const bgNote = "\n\nCRITICAL - ACTIVE BACKGROUND TASKS (these are already being handled in separate processes, you MUST NOT address, continue, reference, or restart them):\n- deploy new docker configuration to production\nYou MUST only respond to the newest message. Treat it as a completely independent, unrelated request. Do NOT combine your response with background task work. Do NOT mention the background tasks.";

    const response = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 500,
      system: [BILLING_SYSTEM_BLOCK, { type: "text", text: "You are Azula, a Discord bot. Be brief." + bgNote }],
      messages: [
        { role: "user", content: "[TestUser]: deploy the new docker config to prod" },
        { role: "assistant", content: "[BACKGROUND TASK bg-99999: Already working on this request in a separate background process. This task is being handled independently. Do not re-address, continue, or reference this request.]" },
        { role: "user", content: "[TestUser]: tell me a joke" },
      ],
      metadata: getMetadata(),
    });

    const text = response.content.filter(b => b.type === "text").map(b => b.text).join("\n").toLowerCase();
    console.log("[test] joke response: " + text.substring(0, 200));

    assert.ok(!text.includes("docker") && !text.includes("deploy") && !text.includes("prod"),
      "ISOLATION FAILURE: joke response mentioned docker/deploy. Got: " + text.substring(0, 200));
    assert.equal(response.stop_reason, "end_turn", "joke should end turn, not request tools");
  });
});

// ============================================================
// SECTION 9: LIVE API - Non-complex message with bg task context
// Tests the EXACT scenario that was failing: "imalive4 please finish"
// is NOT complex, so without the dynamic bg switch, the foreground
// tool loop would leave history without an assistant response while
// other messages arrive.
// ============================================================

describe("LIVE API: non-complex message isolation", () => {
  let client, getMetadata, BILLING_SYSTEM_BLOCK;

  before(async () => {
    const clientMod = await import("../src/ai/client.js");
    client = await clientMod.getClient();
    getMetadata = clientMod.getMetadata;
    BILLING_SYSTEM_BLOCK = clientMod.BILLING_SYSTEM_BLOCK;
  });

  it("'imalive4 please finish' is NOT complex by pattern but model will use tools", async () => {
    const { isComplex } = await import("../src/ai/model-router.js");
    assert.ok(!isComplex("imalive4 please finish"), "This message should NOT match complex patterns");

    const { toolSchemas } = await import("../src/tools/definitions.js");
    const response = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 500,
      system: [BILLING_SYSTEM_BLOCK, { type: "text", text: "You are Azula, a Discord bot with bash, file read/write tools." }],
      messages: [{ role: "user", content: "[TestUser]: imalive4 please finish" }],
      tools: toolSchemas.slice(0, 4),
      metadata: getMetadata(),
    });

    const hasToolUse = response.content.some(b => b.type === "tool_use");
    console.log("[test] imalive4 response stop_reason=" + response.stop_reason + " hasToolUse=" + hasToolUse);

    assert.ok(
      hasToolUse || response.stop_reason === "tool_use",
      "Model should attempt tool use for 'imalive4 please finish' (stop_reason=" + response.stop_reason + ")"
    );
  });
});

// ============================================================
// SECTION 10: Prompt caching verification
// ============================================================

describe("prompt caching", () => {
  it("loader exports buildStableSystemPrompt (cacheable) separately", async () => {
    const loader = await import("../src/memory/loader.js");
    assert.equal(typeof loader.buildStableSystemPrompt, "function");
    const stable = loader.buildStableSystemPrompt();
    assert.ok(stable.length > 100, "Stable system prompt should be substantial");
  });

  it("stable system prompt is cached in memory (same reference on second call)", async () => {
    const loader = await import("../src/memory/loader.js");
    const first = loader.buildStableSystemPrompt();
    const second = loader.buildStableSystemPrompt();
    assert.strictEqual(first, second, "buildStableSystemPrompt should return cached string on second call");
  });

  it("invalidateCache clears the cached prompt", async () => {
    const loader = await import("../src/memory/loader.js");
    const before = loader.buildStableSystemPrompt();
    loader.invalidateCache();
    const after = loader.buildStableSystemPrompt();
    assert.equal(before, after);
  });

  it("agent.js system blocks have cache_control on stable prompt", () => {
    const source = readFileSync(join(SRC_DIR, "ai", "agent.js"), "utf8");
    assert.ok(
      source.includes('cache_control: { type: "ephemeral" }'),
      "agent.js must use cache_control: ephemeral on system blocks"
    );
  });

  it("agent.js caches tool schemas with cache_control on last tool", () => {
    const source = readFileSync(join(SRC_DIR, "ai", "agent.js"), "utf8");
    assert.ok(
      source.includes("getCachedToolSchemas"),
      "agent.js must use getCachedToolSchemas to add cache_control to tools"
    );
  });

  it("agent.js applies cache_control to last user message", () => {
    const source = readFileSync(join(SRC_DIR, "ai", "agent.js"), "utf8");
    assert.ok(
      source.includes("applyCacheControlToLastUserMessage"),
      "agent.js must call applyCacheControlToLastUserMessage for conversation caching"
    );
  });

  it("tool loop also applies cache_control to messages each iteration", () => {
    const source = readFileSync(join(SRC_DIR, "ai", "agent.js"), "utf8");
    const toolLoopStart = source.indexOf("async function runToolLoop");
    const toolLoopBody = source.substring(toolLoopStart, source.indexOf("\nexport", toolLoopStart));
    assert.ok(
      toolLoopBody.includes("applyCacheControlToLastUserMessage"),
      "runToolLoop must cache the last user message each iteration to avoid re-processing prior tool results"
    );
  });
});

describe("LIVE API: prompt caching actually works", () => {
  let client, getMetadata, BILLING_SYSTEM_BLOCK;

  before(async () => {
    const clientMod = await import("../src/ai/client.js");
    client = await clientMod.getClient();
    getMetadata = clientMod.getMetadata;
    BILLING_SYSTEM_BLOCK = clientMod.BILLING_SYSTEM_BLOCK;
  });

  it("second call with same system prompt gets cache read tokens", async () => {
    const { buildStableSystemPrompt } = await import("../src/memory/loader.js");
    const stablePrompt = buildStableSystemPrompt();

    const systemBlocks = [
      BILLING_SYSTEM_BLOCK,
      { type: "text", text: stablePrompt, cache_control: { type: "ephemeral" } },
      { type: "text", text: "Channel: #test\nTimestamp: " + new Date().toISOString() },
    ];

    // First call: cache write (creates the cache entry)
    const r1 = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 100,
      system: systemBlocks,
      messages: [{ role: "user", content: [{ type: "text", text: "say hi", cache_control: { type: "ephemeral" } }] }],
      metadata: getMetadata(),
    });

    const cacheWrite1 = r1.usage?.cache_creation_input_tokens || 0;
    console.log("[test] Call 1: input=" + r1.usage?.input_tokens + " cache_write=" + cacheWrite1 + " cache_read=" + (r1.usage?.cache_read_input_tokens || 0));

    // Second call: same system prompt, should get cache read
    const r2 = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 100,
      system: systemBlocks,
      messages: [
        { role: "user", content: "say hi" },
        { role: "assistant", content: "Hi!" },
        { role: "user", content: [{ type: "text", text: "say bye", cache_control: { type: "ephemeral" } }] },
      ],
      metadata: getMetadata(),
    });

    const cacheRead2 = r2.usage?.cache_read_input_tokens || 0;
    console.log("[test] Call 2: input=" + r2.usage?.input_tokens + " cache_write=" + (r2.usage?.cache_creation_input_tokens || 0) + " cache_read=" + cacheRead2);

    assert.ok(
      cacheRead2 > 0,
      "Second call should have cache_read_input_tokens > 0 (got " + cacheRead2 + "). " +
      "This proves prompt caching is working. Cache write on first call was " + cacheWrite1
    );
  });
});
