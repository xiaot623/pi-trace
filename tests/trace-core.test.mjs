import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LarkTraceConsumer, MarkdownTraceConsumer, TelegramTraceConsumer, TraceCore, matchesTraceFilter, resolveConfig, TraceProducer } from "../dist/index.js";
import { overrides, registerFlags } from "../dist/trace/flags.js";

class CaptureConsumer {
  constructor(name, filter) {
    this.name = name;
    this.filter = filter;
    this.events = [];
  }

  consume(event) {
    this.events.push(event);
  }
}

test("matchesTraceFilter supports realtime, batch, both, and empty filters", () => {
  assert.equal(matchesTraceFilter("realtime"), true);
  assert.equal(matchesTraceFilter("batch", { kinds: [] }), true);
  assert.equal(matchesTraceFilter("realtime", { kinds: ["realtime"] }), true);
  assert.equal(matchesTraceFilter("batch", { kinds: ["realtime"] }), false);
  assert.equal(matchesTraceFilter("batch", { kinds: ["batch"] }), true);
  assert.equal(matchesTraceFilter("realtime", { kinds: ["both"] }), true);
  assert.equal(matchesTraceFilter("batch", { kinds: ["both"] }), true);
});

test("TraceCore dispatches events only to matching consumers", () => {
  const core = new TraceCore();
  const realtime = new CaptureConsumer("realtime", { kinds: ["realtime"] });
  const batch = new CaptureConsumer("batch", { kinds: ["batch"] });
  const both = new CaptureConsumer("both", { kinds: ["both"] });

  core.registerConsumer(realtime);
  core.registerConsumer(batch);
  core.registerConsumer(both);

  core.publish({ id: "r1", kind: "realtime", type: "turn.started", timestamp: 1, payload: { turnIndex: 0 } });
  core.publish({ id: "b1", kind: "batch", type: "turn.record", timestamp: 2, payload: { turnIndex: 0 } });

  assert.deepEqual(realtime.events.map((event) => event.id), ["r1"]);
  assert.deepEqual(batch.events.map((event) => event.id), ["b1"]);
  assert.deepEqual(both.events.map((event) => event.id), ["r1", "b1"]);
});

test("TraceProducer maps pi hooks to realtime and batch trace events", () => {
  let now = 1000;
  const core = new TraceCore();
  const capture = new CaptureConsumer("capture");
  core.registerConsumer(capture);

  const producer = new TraceProducer(core, {
    now: () => now,
    runIdFactory: () => "run-test",
    eventIdFactory: (runId, sequence) => `${runId}-${sequence}`,
  });

  producer.handleInput({ text: "hello" });
  producer.handleAgentStart({});
  producer.handleTurnStart({ turnIndex: 0 });
  producer.handleMessageStart({ message: { role: "assistant" } });
  producer.handleMessageUpdate({
    message: { role: "assistant" },
    assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Hi", partial: {} },
  });
  producer.handleMessageEnd({
    message: {
      role: "assistant",
      content: [{ type: "text", text: "Hi" }],
      provider: "test-provider",
      model: "test-model",
    },
  });

  now = 1100;
  producer.handleToolExecutionStart({ toolCallId: "tool-1", toolName: "bash", args: { command: "echo ok" } });
  producer.handleToolCall({ toolCallId: "tool-1", toolName: "bash", input: { command: "echo ok" } });
  producer.handleToolResult({
    toolCallId: "tool-1",
    toolName: "bash",
    input: { command: "echo ok" },
    content: [{ type: "text", text: "ok" }],
    isError: false,
    details: { exitCode: 0 },
  });

  now = 1250;
  producer.handleToolExecutionEnd({
    toolCallId: "tool-1",
    toolName: "bash",
    result: { content: [{ type: "text", text: "ok" }], details: { exitCode: 0 } },
    isError: false,
  });
  producer.handleTurnEnd({ turnIndex: 0 });
  producer.handleAgentEnd({
    messages: [{ role: "assistant", provider: "test-provider", model: "test-model" }],
  });

  assert.deepEqual(
    capture.events.map((event) => event.type),
    [
      "turn.started",
      "message.started",
      "message.delta",
      "message.ended",
      "message.record",
      "tool.started",
      "tool.result",
      "tool.ended",
      "tool.record",
      "turn.ended",
      "turn.record",
      "agent.run",
    ],
  );

  const delta = capture.events.find((event) => event.type === "message.delta");
  assert.equal(delta.payload.blockType, "text");
  assert.equal(delta.payload.text, "Hi");

  const toolRecord = capture.events.find((event) => event.type === "tool.record");
  assert.deepEqual(toolRecord.payload.input, { command: "echo ok" });
  assert.equal(toolRecord.payload.resultPreview, "ok");
  assert.equal(toolRecord.payload.durationMs, 150);

  const agentRun = capture.events.find((event) => event.type === "agent.run");
  assert.equal(agentRun.payload.input, "hello");
  assert.deepEqual(agentRun.payload.model, { provider: "test-provider", model: "test-model" });
  assert.deepEqual(agentRun.payload.eventIds, ["run-test-5", "run-test-9", "run-test-11"]);
  assert.deepEqual(agentRun.payload.stats, {
    turnCount: 1,
    messageCount: 1,
    toolCount: 1,
    errorCount: 0,
    durationMs: 250,
  });
});


test("MarkdownTraceConsumer writes batch records as a markdown execution document", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-trace-md-"));
  const assetMapPath = join(dir, "pi-trace.assets.json");

  try {
    const consumer = new MarkdownTraceConsumer({ outputDir: dir, assetMapPath });
    const base = { kind: "batch", timestamp: 1, runId: "run-md" };

    consumer.consume({
      ...base,
      id: "m1",
      type: "message.record",
      payload: { role: "user", content: "Run echo", sessionId: "sess-md" },
    });
    consumer.consume({
      ...base,
      id: "m2",
      type: "message.record",
      payload: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "Need to run bash." },
          { type: "text", text: "I will run the command." },
          { type: "toolCall", id: "tool-1", name: "bash", arguments: { command: "echo trace-ok" } },
        ],
      },
    });
    consumer.consume({
      ...base,
      id: "t1",
      type: "tool.record",
      payload: {
        toolName: "bash",
        toolCallId: "tool-1",
        input: { command: "echo trace-ok" },
        resultContent: [{ type: "text", text: "trace-ok" }],
        isError: false,
      },
    });

    const markdownPath = join(dir, "1970-01", "19700101_Run_echo.md");
    const markdown = readFileSync(markdownPath, "utf8");
    assert.match(markdown, /^# 19700101 Run echo/m);
    assert.match(markdown, /^## User/m);
    assert.match(markdown, /Run echo/);
    assert.match(markdown, /^## Thinking/m);
    assert.match(markdown, /Need to run bash\./);
    assert.match(markdown, /^## Assistant/m);
    assert.match(markdown, /I will run the command\./);
    assert.match(markdown, /^## Tool Call: bash \(success\)$/m);
    assert.match(markdown, /```json\n\{"command":"echo trace-ok"\}\n```/);
    assert.match(markdown, /```text\ntrace-ok\n```/);
    assert.doesNotMatch(markdown, /^## Turn/m);
    assert.equal((markdown.match(/^```/gm) ?? []).length, 4);

    const assetMap = JSON.parse(readFileSync(assetMapPath, "utf8"));
    assert.deepEqual(assetMap.sessions["sess-md"].markdown, { path: markdownPath });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});


test("resolveConfig uses a fixed asset directory and default consumer settings", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-trace-defaults-"));

  try {
    const defaults = resolveConfig({ cwd: dir });
    assert.equal(defaults.assetDir, join(dir, "dev_assets"));
    assert.equal(defaults.assetMapPath, join(dir, "dev_assets", "pi-trace.assets.json"));
    assert.equal(defaults.console.enabled, false);
    assert.equal(defaults.markdown.enabled, false);
    assert.equal(defaults.lark.enabled, false);
    assert.equal(defaults.lark.wiki_space_id, "");
    assert.equal(defaults.telegram.enabled, false);
    assert.equal(defaults.telegram.botToken, "");
    assert.deepEqual(defaults.telegram.chatIds, []);

    const overridden = resolveConfig({
      cwd: dir,
      config: {
        consumers: {
          console: { enabled: true, filter: { kinds: ["realtime", "batch"] } },
          markdown: { enabled: true },
        },
      },
    });
    assert.equal(overridden.assetDir, join(dir, "dev_assets"));
    assert.equal(overridden.console.enabled, true);
    assert.deepEqual(overridden.console.filter, { kinds: ["realtime", "batch"] });
    assert.equal(overridden.markdown.enabled, true);
    assert.equal(overridden.lark.enabled, false);
    assert.equal(overridden.telegram.enabled, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveConfig reads config file from dev_assets and merges with programmatic overrides", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-trace-config-"));
  const assetDir = join(dir, "dev_assets");
  const configPath = join(assetDir, "pi-trace.config.json");
  const now = new Date("2026-05-29T12:34:56.789Z");

  try {
    mkdirSync(assetDir, { recursive: true });
    writeFileSync(
      configPath,
      JSON.stringify({
        consumers: {
          console: { enabled: false, filter: { kinds: ["realtime"] } },
          markdown: { enabled: false },
        },
      }),
      "utf8",
    );

    const fromFile = resolveConfig({ cwd: dir, now });

    assert.equal(fromFile.assetDir, assetDir);
    assert.equal(fromFile.console.enabled, false);
    assert.deepEqual(fromFile.console.filter, { kinds: ["realtime"] });
    assert.equal(fromFile.markdown.enabled, false);
    assert.equal(fromFile.lark.enabled, false);
    assert.equal(fromFile.lark.wiki_space_id, "");
    assert.equal(fromFile.telegram.enabled, false);

    const overridden = resolveConfig({
      cwd: dir,
      now,
      config: {
        consumers: {
          console: { enabled: true, filter: { kinds: ["both"] } },
          markdown: { enabled: true },
        },
      },
    });

    assert.equal(overridden.console.enabled, true);
    assert.deepEqual(overridden.console.filter, { kinds: ["both"] });
    assert.equal(overridden.markdown.enabled, true);
    assert.equal(overridden.lark.enabled, false);
    assert.equal(overridden.telegram.enabled, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveConfig places the asset map next to the active config file", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-trace-config-dir-"));
  const configDir = join(dir, "custom-config");
  const configPath = join(configDir, "pi-trace.config.json");
  const previous = process.env.PI_TRACE_CONFIG;

  try {
    process.env.PI_TRACE_CONFIG = configPath;
    const config = resolveConfig({ cwd: dir, env: "production" });

    assert.equal(config.assetDir, join(dir, "dev_assets"));
    assert.equal(config.assetMapPath, join(configDir, "pi-trace.assets.json"));
    assert.equal(existsSync(configPath), true);
  } finally {
    if (previous === undefined) {
      delete process.env.PI_TRACE_CONFIG;
    } else {
      process.env.PI_TRACE_CONFIG = previous;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveConfig creates a default config file on first use", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-trace-first-use-"));

  try {
    const config = resolveConfig({ cwd: dir });
    const configPath = join(dir, "dev_assets", "pi-trace.config.json");

    assert.equal(existsSync(configPath), true);
    assert.equal(config.assetDir, join(dir, "dev_assets"));

    // Verify the written config has correct defaults
    const writtenConfig = JSON.parse(readFileSync(configPath, "utf8"));
    assert.equal(writtenConfig.consumers.console.enabled, false);
    assert.deepEqual(writtenConfig.consumers.console.filter, { kinds: ["both"] });
    assert.equal(writtenConfig.consumers.markdown.enabled, false);
    assert.equal(writtenConfig.consumers.lark.enabled, false);
    assert.equal(writtenConfig.consumers.lark.wiki_space_id, "");
    assert.equal(writtenConfig.consumers.telegram.enabled, false);
    assert.equal(writtenConfig.consumers.telegram.botToken, "");
    assert.deepEqual(writtenConfig.consumers.telegram.chatIds, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveConfig merges lark config when enabled in config file", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-trace-lark-enabled-"));
  const assetDir = join(dir, "dev_assets");
  const configPath = join(assetDir, "pi-trace.config.json");

  try {
    mkdirSync(assetDir, { recursive: true });
    writeFileSync(
      configPath,
      JSON.stringify({
        consumers: {
          lark: { enabled: true, wiki_space_id: "custom-space-456" },
        },
      }),
      "utf8",
    );

    const config = resolveConfig({ cwd: dir });
    assert.equal(config.lark.enabled, true);
    assert.equal(config.lark.wiki_space_id, "custom-space-456");

    const overridden = resolveConfig({
      cwd: dir,
      config: {
        consumers: {
          lark: { wiki_space_id: "override-space-789" },
        },
      },
    });
    assert.equal(overridden.lark.enabled, true);
    assert.equal(overridden.lark.wiki_space_id, "override-space-789");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveConfig merges telegram config and supports env token override", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-trace-telegram-enabled-"));
  const assetDir = join(dir, "dev_assets");
  const configPath = join(assetDir, "pi-trace.config.json");
  const previousToken = process.env.PI_TRACE_TELEGRAM_BOT_TOKEN;
  const previousChatIds = process.env.PI_TRACE_TELEGRAM_CHAT_IDS;

  try {
    mkdirSync(assetDir, { recursive: true });
    writeFileSync(
      configPath,
      JSON.stringify({
        consumers: {
          telegram: { enabled: false, botToken: "file-token", chatIds: ["1", "-1002"] },
        },
      }),
      "utf8",
    );

    const fromFile = resolveConfig({ cwd: dir });
    assert.equal(fromFile.telegram.enabled, false);
    assert.equal(fromFile.telegram.botToken, "file-token");
    assert.deepEqual(fromFile.telegram.chatIds, ["1", "-1002"]);

    process.env.PI_TRACE_TELEGRAM_BOT_TOKEN = "env-token";
    process.env.PI_TRACE_TELEGRAM_CHAT_IDS = "3, -1004";
    const fromEnv = resolveConfig({ cwd: dir });
    assert.equal(fromEnv.telegram.enabled, true);
    assert.equal(fromEnv.telegram.botToken, "env-token");
    assert.deepEqual(fromEnv.telegram.chatIds, ["3", "-1004"]);

    delete process.env.PI_TRACE_TELEGRAM_CHAT_IDS;
    const partialEnv = resolveConfig({ cwd: dir });
    assert.equal(partialEnv.telegram.enabled, false);
    assert.equal(partialEnv.telegram.botToken, "file-token");
    assert.deepEqual(partialEnv.telegram.chatIds, ["1", "-1002"]);
  } finally {
    if (previousToken === undefined) delete process.env.PI_TRACE_TELEGRAM_BOT_TOKEN;
    else process.env.PI_TRACE_TELEGRAM_BOT_TOKEN = previousToken;
    if (previousChatIds === undefined) delete process.env.PI_TRACE_TELEGRAM_CHAT_IDS;
    else process.env.PI_TRACE_TELEGRAM_CHAT_IDS = previousChatIds;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("registerFlags reads topic after session_start when CLI flags are available", () => {
  let flagValue;
  const handlers = new Map();
  const pi = {
    registerFlag(name, options) {
      assert.equal(name, "topic");
      assert.equal(options.type, "string");
    },
    getFlag(name) {
      assert.equal(name, "topic");
      return flagValue;
    },
    on(eventName, handler) {
      handlers.set(eventName, handler);
    },
  };

  try {
    delete overrides.telegramThreadId;
    registerFlags(pi);
    assert.equal(overrides.telegramThreadId, undefined);

    flagValue = "12345";
    handlers.get("session_start")();
    assert.equal(overrides.telegramThreadId, "12345");
  } finally {
    delete overrides.telegramThreadId;
  }
});

test("TelegramTraceConsumer creates topics, updates temporary messages, and sends summaries", async () => {
  const calls = [];
  let messageId = 100;
  const dir = mkdtempSync(join(tmpdir(), "pi-trace-telegram-map-"));
  const assetMapPath = join(dir, "pi-trace.assets.json");

  try {
    const consumer = new TelegramTraceConsumer({
      botToken: "test-token",
      chatIds: ["123", "-100456"],
      assetMapPath,
      request: async (method, body) => {
        calls.push({ method, body });
        if (method === "createForumTopic") {
          if (body.chat_id === "123") throw new Error("Bad Request: chat not found");
          return { message_thread_id: 42 };
        }
        if (method === "sendMessage") {
          const result = { message_id: ++messageId };
          calls.at(-1).resultMessageId = result.message_id;
          return result;
        }
        if (method === "editMessageText") return true;
        throw new Error(`unexpected method ${method}`);
      },
    });
    const base = { kind: "batch", timestamp: 1, runId: "run-tg" };

    await consumer.consume({
      ...base,
      id: "m1",
      type: "message.record",
      payload: {
        role: "assistant",
        sessionId: "sess-tg",
        sessionName: "telegram-session",
        modelId: "gpt-4",
        modelProvider: "openai",
        cwd: "/test/workspace",
        content: [
          { type: "thinking", thinking: "Need to answer." },
          { type: "text", text: "First answer." },
        ],
      },
    });

    await consumer.consume({
      ...base,
      id: "m2",
      type: "message.record",
      payload: {
        role: "assistant",
        content: [{ type: "text", text: "Final answer for the turn." }],
      },
    });

    await consumer.consume({
      ...base,
      id: "t1",
      type: "tool.record",
      payload: {
        toolName: "bash",
        input: { command: "echo ok" },
        isError: false,
      },
    });

    await consumer.consume({
      ...base,
      id: "turn1",
      type: "turn.record",
      payload: { turnIndex: 0 },
    });

    await consumer.consume({
      ...base,
      id: "run1",
      type: "agent.run",
      payload: {
        stats: {
          turnCount: 1,
          messageCount: 2,
          toolCount: 1,
          errorCount: 0,
          durationMs: 1250,
          inputTokens: 10,
          outputTokens: 20,
          cacheReadTokens: 3,
          totalTokens: 30,
          cost: 0.01234,
        },
      },
    });

    assert.deepEqual(
      calls.filter((call) => call.method === "createForumTopic").map((call) => call.body.chat_id),
      ["-100456"],
    );
    assert.equal(calls.find((call) => call.method === "createForumTopic").body.name, "telegram-session 19700101");

    const topicSend = calls.find((call) => call.method === "sendMessage" && call.body.chat_id === "-100456");
    assert.equal(topicSend.body.message_thread_id, 42);

    const edits = calls.filter((call) => call.method === "editMessageText");
    assert.ok(edits.some((call) => call.body.text === "🤖 <b>Assistant</b>\n\nFinal answer for the turn."));
    assert.ok(edits.every((call) => call.body.parse_mode === "HTML"));
    assert.ok(edits.every((call) => call.body.message_thread_id === undefined));

    const deletes = calls.filter((call) => call.method === "deleteMessage");
    assert.equal(deletes.length, 2, "only non-topic chats should clean up transient thinking/tool messages");

    const sendMessages = calls.filter((call) => call.method === "sendMessage");
    assert.ok(sendMessages.every((call) => call.body.parse_mode === "HTML"));
    assert.equal(sendMessages.filter((call) => !String(call.body.text).startsWith("📊 <b>Run Summary</b>")).length, 7);
    assert.ok(sendMessages.some((call) => String(call.body.text).startsWith("💭 <b>Thinking</b>")));
    assert.ok(sendMessages.some((call) => String(call.body.text).startsWith("🛠 <b>Tool Call</b>") && String(call.body.text).includes("[bash] echo ok")));
    assert.ok(sendMessages.some((call) => String(call.body.text).startsWith("🤖 <b>Assistant</b>")));
    const assistantMessageIds = sendMessages
      .filter((call) => String(call.body.text).startsWith("🤖 <b>Assistant</b>"))
      .map((call) => call.resultMessageId)
      .filter(Boolean);
    assert.ok(deletes.every((call) => !assistantMessageIds.includes(call.body.message_id)));

    const topicAssistantSends = sendMessages.filter((call) => call.body.chat_id === "-100456" && String(call.body.text).startsWith("🤖 <b>Assistant</b>"));
    assert.equal(topicAssistantSends.length, 2);
    assert.ok(edits.every((call) => call.body.chat_id === "123"));

    const runSummaries = calls.filter((call) => call.method === "sendMessage" && String(call.body.text).startsWith("📊 <b>Run Summary</b>"));
    assert.equal(runSummaries.length, 2);
    assert.match(runSummaries[0].body.text, /Tokens: 30 \| In: 10 \(cached 3\) \| Out: 20 \| Cost: \$0\.0123/);
    assert.match(runSummaries[0].body.text, /Turns: 1 \| Loops: 1 \| Messages: 2 \| Tools: 1 \| Errors: 0 \| Duration: 1\.3s/);

    const assetMap = JSON.parse(readFileSync(assetMapPath, "utf8"));
    assert.deepEqual(assetMap.sessions["sess-tg"].telegram.chats, [
      { chatId: "123", topicCreated: false, summaryMessageIds: [108] },
      { chatId: "-100456", topicName: "telegram-session 19700101", messageThreadId: 42, topicCreated: true, summaryMessageIds: [109] },
    ]);
    assert.deepEqual(assetMap.sessions["sess-tg"].telegram.totals, {
      loops: 1,
      turnCount: 1,
      messageCount: 2,
      toolCount: 1,
      errorCount: 0,
      durationMs: 1250,
      inputTokens: 10,
      outputTokens: 20,
      cacheReadTokens: 3,
      cacheWriteTokens: 0,
      totalTokens: 30,
      cost: 0.01234,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("TelegramTraceConsumer reuses external topic from flag override", async () => {
  const calls = [];
  let messageId = 150;
  const dir = mkdtempSync(join(tmpdir(), "pi-trace-telegram-external-topic-"));
  const assetMapPath = join(dir, "pi-trace.assets.json");

  try {
    overrides.telegramThreadId = "88";
    const consumer = new TelegramTraceConsumer({
      botToken: "test-token",
      chatIds: ["-100456"],
      assetMapPath,
      request: async (method, body) => {
        calls.push({ method, body });
        if (method === "sendMessage") return { message_id: ++messageId };
        if (method === "editMessageText") return true;
        throw new Error(`unexpected method ${method}`);
      },
    });
    const base = { kind: "batch", timestamp: 1, runId: "run-tg" };

    await consumer.consume({
      ...base,
      id: "m1",
      type: "message.record",
      payload: {
        role: "assistant",
        sessionId: "sess-external-topic",
        sessionName: "external",
        content: [{ type: "text", text: "Use the existing topic." }],
      },
    });

    await consumer.consume({
      ...base,
      id: "run1",
      type: "agent.run",
      payload: {
        stats: { turnCount: 1, messageCount: 1, toolCount: 0, errorCount: 0, durationMs: 10 },
      },
    });

    assert.ok(calls.every((call) => call.method !== "createForumTopic"));
    assert.ok(calls.filter((call) => call.method === "sendMessage").every((call) => call.body.message_thread_id === 88));

    const assetMap = JSON.parse(readFileSync(assetMapPath, "utf8"));
    assert.deepEqual(assetMap.sessions["sess-external-topic"].telegram.chats[0], {
      chatId: "-100456",
      topicName: "(external)",
      messageThreadId: 88,
      topicCreated: false,
      summaryMessageIds: [152],
    });
  } finally {
    delete overrides.telegramThreadId;
    rmSync(dir, { recursive: true, force: true });
  }
});


test("TelegramTraceConsumer does not use topics for direct chats", async () => {
  const calls = [];
  let messageId = 250;
  const consumer = new TelegramTraceConsumer({
    botToken: "test-token",
    chatIds: ["8798866909"],
    request: async (method, body) => {
      calls.push({ method, body });
      if (method === "sendMessage") return { message_id: ++messageId };
      if (method === "editMessageText") return true;
      throw new Error(`unexpected method ${method}`);
    },
  });
  const base = { kind: "batch", timestamp: 1, runId: "run-tg" };

  await consumer.consume({
    ...base,
    id: "m1",
    type: "message.record",
    payload: {
      role: "assistant",
      sessionId: "sess-direct",
      sessionName: "direct",
      content: [{ type: "text", text: "Direct chat message." }],
    },
  });

  await consumer.consume({
    ...base,
    id: "run1",
    type: "agent.run",
    payload: {
      stats: { turnCount: 1, messageCount: 1, toolCount: 0, errorCount: 0, durationMs: 10 },
    },
  });

  assert.deepEqual(calls.map((call) => call.method), ["sendMessage", "editMessageText", "sendMessage"]);
  assert.ok(calls.every((call) => !["createForumTopic", "closeForumTopic", "reopenForumTopic"].includes(call.method)));
  assert.ok(calls.every((call) => call.body.message_thread_id === undefined));
  assert.ok(calls.every((call) => call.body.parse_mode === "HTML"));
});

test("TelegramTraceConsumer sends ordered topic tool cards and resets after assistant messages", async () => {
  const calls = [];
  let messageId = 320;

  try {
    overrides.telegramThreadId = "88";
    const consumer = new TelegramTraceConsumer({
      botToken: "test-token",
      chatIds: ["-100456"],
      request: async (method, body) => {
        calls.push({ method, body });
        if (method === "sendMessage") return { message_id: ++messageId };
        if (method === "editMessageText") return true;
        throw new Error(`unexpected method ${method}`);
      },
    });
    const base = { kind: "batch", timestamp: 1, runId: "run-tg" };

    await consumer.consume({
      ...base,
      id: "tool-1",
      type: "tool.record",
      payload: { toolName: "bash", input: { command: "echo 1" }, isError: false },
    });

    await consumer.consume({
      ...base,
      id: "tool-2",
      type: "tool.record",
      payload: { toolName: "bash", input: { command: "echo 2" }, isError: false },
    });

    await consumer.consume({
      ...base,
      id: "msg-1",
      type: "message.record",
      payload: {
        role: "assistant",
        sessionId: "sess-topic-tool-reset",
        sessionName: "topic-reset",
        content: [{ type: "text", text: "Assistant update." }],
      },
    });

    await consumer.consume({
      ...base,
      id: "tool-3",
      type: "tool.record",
      payload: { toolName: "bash", input: { command: "echo 3" }, isError: false },
    });

    const toolSends = calls.filter((call) => call.method === "sendMessage" && String(call.body.text).startsWith("🛠 <b>Tool Call</b>"));
    const toolEdits = calls.filter((call) => call.method === "editMessageText" && String(call.body.text).startsWith("🛠 <b>Tool Call</b>"));
    assert.equal(toolSends.length, 2);
    assert.equal(toolEdits.length, 1);
    assert.ok(toolEdits[0].body.text.includes("[bash] echo 1\n[bash] echo 2"));
    assert.ok(toolSends.every((call) => call.body.message_thread_id === 88));
    assert.equal(calls.filter((call) => call.method === "deleteMessage").length, 0);
  } finally {
    delete overrides.telegramThreadId;
  }
});

test("TelegramTraceConsumer rolls topic tool cards when the current card is full", async () => {
  const calls = [];
  let messageId = 340;

  try {
    overrides.telegramThreadId = "88";
    const consumer = new TelegramTraceConsumer({
      botToken: "test-token",
      chatIds: ["-100456"],
      request: async (method, body) => {
        calls.push({ method, body });
        if (method === "sendMessage") return { message_id: ++messageId };
        if (method === "editMessageText") return true;
        throw new Error(`unexpected method ${method}`);
      },
    });
    const base = { kind: "batch", timestamp: 1, runId: "run-tg" };
    const longCommand = `echo ${"x".repeat(400)}`;

    for (let i = 0; i < 18; i += 1) {
      await consumer.consume({
        ...base,
        id: `tool-roll-${i}`,
        type: "tool.record",
        payload: { toolName: "bash", input: { command: longCommand }, isError: false },
      });
    }

    const toolSends = calls.filter((call) => call.method === "sendMessage" && String(call.body.text).startsWith("🛠 <b>Tool Call</b>"));
    const toolEdits = calls.filter((call) => call.method === "editMessageText" && String(call.body.text).startsWith("🛠 <b>Tool Call</b>"));
    assert.ok(toolSends.length >= 2);
    assert.ok(toolEdits.length >= 1);
    assert.equal(calls.filter((call) => call.method === "deleteMessage").length, 0);
  } finally {
    delete overrides.telegramThreadId;
  }
});

test("TelegramTraceConsumer deletes replaced progress messages when edit fails", async () => {
  const calls = [];
  let messageId = 260;
  const consumer = new TelegramTraceConsumer({
    botToken: "test-token",
    chatIds: ["8798866909"],
    request: async (method, body) => {
      calls.push({ method, body });
      if (method === "sendMessage") {
        const result = { message_id: ++messageId };
        calls.at(-1).resultMessageId = result.message_id;
        return result;
      }
      if (method === "editMessageText") throw new Error("Bad Request: message can't be edited");
      if (method === "deleteMessage") return true;
      throw new Error(`unexpected method ${method}`);
    },
  });
  const base = { kind: "batch", timestamp: 1, runId: "run-tg" };

  await consumer.consume({
    ...base,
    id: "m-short",
    type: "message.record",
    payload: {
      role: "assistant",
      sessionId: "sess-edit-fail",
      sessionName: "edit-fail",
      content: [{ type: "text", text: "Short assistant message." }],
    },
  });

  await consumer.consume({
    ...base,
    id: "m-long",
    type: "message.record",
    payload: {
      role: "assistant",
      content: [{ type: "text", text: `${"Long assistant message. ".repeat(260)}` }],
    },
  });

  const assistantSends = calls.filter((call) => call.method === "sendMessage" && String(call.body.text).startsWith("🤖 <b>Assistant"));
  assert.equal(assistantSends.length, 3);
  assert.deepEqual(
    calls.filter((call) => call.method === "deleteMessage").map((call) => call.body.message_id),
    [assistantSends[0].resultMessageId],
  );
});

test("TelegramTraceConsumer reports session loop count from completed agent runs", async () => {
  const calls = [];
  let messageId = 275;
  const consumer = new TelegramTraceConsumer({
    botToken: "test-token",
    chatIds: ["8798866909"],
    request: async (method, body) => {
      calls.push({ method, body });
      if (method === "sendMessage") return { message_id: ++messageId };
      if (method === "editMessageText") return true;
      throw new Error(`unexpected method ${method}`);
    },
  });
  const base = { kind: "batch", timestamp: 1, runId: "run-tg" };

  for (const text of ["First loop.", "Second loop."]) {
    await consumer.consume({
      ...base,
      id: `m-${text}`,
      type: "message.record",
      payload: {
        role: "assistant",
        sessionId: "sess-loop",
        sessionName: "loop-session",
        content: [{ type: "text", text }],
      },
    });

    await consumer.consume({
      ...base,
      id: `run-${text}`,
      type: "agent.run",
      payload: {
        stats: { turnCount: 3, messageCount: 1, toolCount: 0, errorCount: 0, durationMs: 10 },
      },
    });
  }

  const summaries = calls
    .filter((call) => call.method === "sendMessage" && String(call.body.text).startsWith("📊 <b>Run Summary</b>"))
    .map((call) => call.body.text);

  assert.match(summaries[0], /Turns: 3 \| Loops: 1 \| Messages: 1/);
  assert.match(summaries[1], /Turns: 6 \| Loops: 2 \| Messages: 2/);
});

test("TelegramTraceConsumer restores cumulative totals from asset map", async () => {
  const calls = [];
  let messageId = 290;
  const dir = mkdtempSync(join(tmpdir(), "pi-trace-telegram-totals-"));
  const assetMapPath = join(dir, "pi-trace.assets.json");

  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(assetMapPath, JSON.stringify({
      sessions: {
        "sess-totals": {
          telegram: {
            chats: [{ chatId: "8798866909", topicCreated: false, summaryMessageIds: [288] }],
            totals: {
              loops: 2,
              turnCount: 5,
              messageCount: 8,
              toolCount: 3,
              errorCount: 1,
              durationMs: 1000,
              inputTokens: 100,
              outputTokens: 50,
              cacheReadTokens: 20,
              cacheWriteTokens: 0,
              totalTokens: 150,
              cost: 0.01,
            },
          },
        },
      },
    }, null, 2) + "\n", "utf8");

    const consumer = new TelegramTraceConsumer({
      botToken: "test-token",
      chatIds: ["8798866909"],
      assetMapPath,
      request: async (method, body) => {
        calls.push({ method, body });
        if (method === "sendMessage") return { message_id: ++messageId };
        if (method === "editMessageText") return true;
        if (method === "deleteMessage") return true;
        throw new Error(`unexpected method ${method}`);
      },
    });
    const base = { kind: "batch", timestamp: 1, runId: "run-tg" };

    await consumer.consume({
      ...base,
      id: "m-total",
      type: "message.record",
      payload: {
        role: "assistant",
        sessionId: "sess-totals",
        sessionName: "totals",
        content: [{ type: "text", text: "Restored totals." }],
      },
    });

    await consumer.consume({
      ...base,
      id: "run-total",
      type: "agent.run",
      payload: {
        stats: {
          turnCount: 2,
          messageCount: 3,
          toolCount: 4,
          errorCount: 0,
          durationMs: 500,
          inputTokens: 10,
          outputTokens: 5,
          cacheReadTokens: 2,
          totalTokens: 15,
          cost: 0.001,
        },
      },
    });

    const summary = calls.find((call) => call.method === "sendMessage" && String(call.body.text).startsWith("📊 <b>Run Summary</b>")).body.text;
    assert.match(summary, /Tokens: 165 \| In: 110 \(cached 22\) \| Out: 55 \| Cost: \$0\.0110/);
    assert.match(summary, /Turns: 7 \| Loops: 3 \| Messages: 11 \| Tools: 7 \| Errors: 1 \| Duration: 1\.5s/);

    const assetMap = JSON.parse(readFileSync(assetMapPath, "utf8"));
    assert.equal(assetMap.sessions["sess-totals"].telegram.totals.loops, 3);
    assert.equal(assetMap.sessions["sess-totals"].telegram.totals.turnCount, 7);
    assert.equal(assetMap.sessions["sess-totals"].telegram.totals.totalTokens, 165);
    assert.ok(calls.some((call) => call.method === "deleteMessage" && call.body.message_id === 288));
    assert.deepEqual(assetMap.sessions["sess-totals"].telegram.chats[0].summaryMessageIds, [292]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});


test("LarkTraceConsumer generates Feishu markdown content and calls lark-cli with correct arguments", async () => {
  // Mock lark-cli executor
  const calls = [];
  const dir = mkdtempSync(join(tmpdir(), "pi-trace-lark-map-"));
  const assetMapPath = join(dir, "pi-trace.assets.json");
  class MockLarkConsumer extends LarkTraceConsumer {
    execLarkCli(args, stdin) {
      calls.push({ args, stdin });
      if (args.includes("+node-list")) {
        return JSON.stringify({
          ok: true,
          data: {
            items: [
              { title: "1970-01", node_token: "month-node-123", obj_token: "month-doc-123" }
            ]
          }
        });
      }
      // Simulate trace document create response
      if (args.includes("+node-create")) {
        return JSON.stringify({
          ok: true,
          data: {
            node_token: "node-test-123",
            obj_token: "doxcn-test-123",
            url: "https://example.larksuite.com/docx/doxcn-test-123",
            title: "test-session"
          }
        });
      }
      return JSON.stringify({ ok: true });
    }
  }

  const consumer = new MockLarkConsumer({ wikiSpaceId: "test-space-123", assetMapPath });
  const base = { kind: "batch", timestamp: 1, runId: "run-lark" };

  // Feed events (await the turn.record which triggers flush)
  consumer.consume({
    ...base,
    id: "m1",
    type: "message.record",
    payload: {
      role: "user",
      content: "Run `echo`",
      sessionId: "sess-123",
      sessionName: "test-session",
      modelId: "gpt-4",
      modelProvider: "openai",
      cwd: "/test/workspace",
      userInput: "Run `echo`"
    },
  });

  consumer.consume({
    ...base,
    id: "m2",
    type: "message.record",
    payload: {
      role: "assistant",
      content: [
        { type: "text", text: "I will run **the command**.\n\n- first\n- second" },
      ],
    },
  });

  consumer.consume({
    ...base,
    id: "t1",
    type: "tool.record",
    payload: {
      toolName: "bash",
      toolCallId: "tool-1",
      input: { command: "echo test" },
      resultContent: [{ type: "text", text: "test output" }],
      isError: false,
    },
  });

  await consumer.consume({
    ...base,
    id: "turn1",
    type: "turn.record",
    payload: { turnIndex: 0 },
  });

  // Verify lark-cli was called
  assert.equal(calls.length, 4, "should call lark-cli four times (find month + create child node + append callout + append content)");

  // First call: find month wiki node
  const monthLookupCall = calls[0];
  assert.ok(monthLookupCall.args.includes("+node-list"));
  assert.ok(monthLookupCall.args.includes("--page-all"));
  assert.ok(monthLookupCall.args.includes("--space-id"));
  assert.ok(monthLookupCall.args.includes("test-space-123"));

  // Second call: create wiki node under month document
  const createCall = calls[1];
  assert.ok(createCall.args.includes("+node-create"));
  assert.ok(createCall.args.includes("--space-id"));
  assert.ok(createCall.args.includes("test-space-123"));
  assert.ok(createCall.args.includes("--parent-node-token"));
  assert.ok(createCall.args.includes("month-node-123"));
  assert.equal(createCall.args[createCall.args.indexOf("--title") + 1], "19700101 test-session");

  // Third call: append callout
  const calloutCall = calls[2];
  assert.ok(calloutCall.args.includes("+update"));
  assert.ok(calloutCall.args.includes("--command"));
  assert.ok(calloutCall.args.includes("append"));
  assert.ok(calloutCall.args.includes("--doc-format"));
  assert.equal(calloutCall.args[calloutCall.args.indexOf("--doc-format") + 1], "markdown");
  assert.match(calloutCall.stdin, /<callout[^>]*>/);
  assert.match(calloutCall.stdin, /<b>Run ID:<\/b>.*run-lark/);
  assert.match(calloutCall.stdin, /<b>Session Name:<\/b>.*test-session/);
  assert.match(calloutCall.stdin, /<b>Model:<\/b>.*openai\/gpt-4/);

  // Fourth call: append content
  const appendCall = calls[3];
  assert.ok(appendCall.args.includes("+update"));
  assert.ok(appendCall.args.includes("--command"));
  assert.ok(appendCall.args.includes("append"));
  assert.ok(appendCall.args.includes("--doc-format"));
  assert.equal(appendCall.args[appendCall.args.indexOf("--doc-format") + 1], "markdown");
  assert.ok(appendCall.args.includes("--doc"));
  assert.ok(appendCall.args.includes("doxcn-test-123"));
  assert.match(appendCall.stdin, /^## User\n\nRun `echo`/m);
  assert.match(appendCall.stdin, /^## Assistant\n\nI will run \*\*the command\*\*\./m);
  assert.match(appendCall.stdin, /- first\n- second/);
  assert.match(appendCall.stdin, /^## Tool Call: bash \(success\)$/m);
  assert.match(appendCall.stdin, /```json\n\{"command":"echo test"\}\n```/);
  assert.match(appendCall.stdin, /```text\ntest output\n```/);

  const assetMap = JSON.parse(readFileSync(assetMapPath, "utf8"));
  assert.deepEqual(assetMap.sessions["sess-123"].lark, {
    documentToken: "doxcn-test-123",
    documentUrl: "https://example.larksuite.com/docx/doxcn-test-123",
    wikiSpaceId: "test-space-123",
    month: "1970-01",
    monthNodeToken: "month-node-123",
  });

  rmSync(dir, { recursive: true, force: true });
});

test("LarkTraceConsumer chunks long content correctly", async () => {
  const calls = [];
  class MockLarkConsumer extends LarkTraceConsumer {
    execLarkCli(args, stdin) {
      calls.push({ args, stdin });
      if (args.includes("+node-list")) {
        return JSON.stringify({
          ok: true,
          data: { items: [{ title: "1970-01", node_token: "month-node-456" }] }
        });
      }
      if (args.includes("+node-create")) {
        return JSON.stringify({
          ok: true,
          data: { obj_token: "doc-456" }
        });
      }
      return JSON.stringify({ ok: true });
    }
  }

  const consumer = new MockLarkConsumer({ wikiSpaceId: "space-456" });
  const base = { kind: "batch", timestamp: 1, runId: "run-chunk" };

  // Create a very long tool result (50KB)
  const longText = "x".repeat(50000);

  consumer.consume({
    ...base,
    id: "t1",
    type: "tool.record",
    payload: {
      toolName: "read",
      toolCallId: "tool-2",
      input: { path: "big.txt" },
      resultContent: [{ type: "text", text: longText }],
      isError: false,
    },
  });

  await consumer.consume({
    ...base,
    id: "turn1",
    type: "turn.record",
    payload: { turnIndex: 0 },
  });

  // Should have multiple append calls due to chunking
  const appendCalls = calls.filter(c => c.args.includes("append"));
  assert.ok(appendCalls.length >= 2, `should chunk long content, got ${appendCalls.length} append calls`);

  // All chunks should be under the limit (30KB)
  for (const call of appendCalls) {
    assert.ok(call.stdin.length <= 30000, `chunk size ${call.stdin.length} exceeds 30KB limit`);
  }

  // Total content should be preserved (approximately)
  const totalLength = appendCalls.reduce((sum, c) => sum + c.stdin.length, 0);
  assert.ok(totalLength > 40000, `total content ${totalLength} should preserve most of the 50KB`);
});
