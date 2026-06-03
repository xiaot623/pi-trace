import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LarkTraceConsumer, MarkdownTraceConsumer, TelegramTraceConsumer, TraceCore, matchesTraceFilter, resolveConfig, TraceProducer } from "../dist/index.js";

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
          telegram: { enabled: true, botToken: "file-token", chatIds: ["1", "-1002"] },
        },
      }),
      "utf8",
    );

    const fromFile = resolveConfig({ cwd: dir });
    assert.equal(fromFile.telegram.enabled, true);
    assert.equal(fromFile.telegram.botToken, "file-token");
    assert.deepEqual(fromFile.telegram.chatIds, ["1", "-1002"]);

    process.env.PI_TRACE_TELEGRAM_BOT_TOKEN = "env-token";
    process.env.PI_TRACE_TELEGRAM_CHAT_IDS = "3, -1004";
    const fromEnv = resolveConfig({ cwd: dir });
    assert.equal(fromEnv.telegram.botToken, "env-token");
    assert.deepEqual(fromEnv.telegram.chatIds, ["3", "-1004"]);
  } finally {
    if (previousToken === undefined) delete process.env.PI_TRACE_TELEGRAM_BOT_TOKEN;
    else process.env.PI_TRACE_TELEGRAM_BOT_TOKEN = previousToken;
    if (previousChatIds === undefined) delete process.env.PI_TRACE_TELEGRAM_CHAT_IDS;
    else process.env.PI_TRACE_TELEGRAM_CHAT_IDS = previousChatIds;
    rmSync(dir, { recursive: true, force: true });
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
        if (method === "sendMessage") return { message_id: ++messageId };
        if (method === "editMessageText") return true;
        if (method === "deleteMessage") return true;
        if (method === "closeForumTopic") return true;
        if (method === "reopenForumTopic") return true;
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
    assert.equal(calls.find((call) => call.method === "createForumTopic").body.name, "19700101_");

    const topicSend = calls.find((call) => call.method === "sendMessage" && call.body.chat_id === "-100456");
    assert.equal(topicSend.body.message_thread_id, 42);

    const edits = calls.filter((call) => call.method === "editMessageText");
    assert.ok(edits.some((call) => call.body.text === "Final answer for the turn."));

    const deletes = calls.filter((call) => call.method === "deleteMessage");
    assert.equal(deletes.length, 6, "three temporary messages per chat should be deleted at turn end");

    const stageSummaries = calls.filter((call) => call.method === "sendMessage" && call.body.text === "Final answer for the turn.");
    assert.equal(stageSummaries.length, 2);

    const runSummaries = calls.filter((call) => call.method === "sendMessage" && String(call.body.text).startsWith("Run Summary"));
    assert.equal(runSummaries.length, 2);
    assert.match(runSummaries[0].body.text, /Tokens: 30 \| In: 10 \(cached 3\) \| Out: 20 \| Cost: \$0\.0123/);
    assert.match(runSummaries[0].body.text, /Turns: 1 \| Messages: 2 \| Tools: 1 \| Errors: 0 \| Duration: 1\.3s/);

    const topicCloses = calls.filter((call) => call.method === "closeForumTopic");
    assert.deepEqual(topicCloses.map((call) => call.body), [
      { chat_id: "-100456", message_thread_id: 42 },
    ]);

    const assetMap = JSON.parse(readFileSync(assetMapPath, "utf8"));
    assert.deepEqual(assetMap.sessions["sess-tg"].telegram.chats, [
      { chatId: "123", topicCreated: false },
      { chatId: "-100456", topicName: "19700101_", messageThreadId: 42, topicCreated: true, topicClosed: true },
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("TelegramTraceConsumer closes the previous topic before switching sessions", async () => {
  const calls = [];
  let threadId = 40;
  let messageId = 200;
  const consumer = new TelegramTraceConsumer({
    botToken: "test-token",
    chatIds: ["-100456"],
    request: async (method, body) => {
      calls.push({ method, body });
      if (method === "createForumTopic") return { message_thread_id: ++threadId };
      if (method === "sendMessage") return { message_id: ++messageId };
      if (method === "deleteMessage") return true;
      if (method === "closeForumTopic") return true;
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
      sessionId: "sess-one",
      sessionName: "one",
      content: [{ type: "text", text: "First session." }],
    },
  });

  await consumer.consume({
    ...base,
    id: "m2",
    type: "message.record",
    payload: {
      role: "assistant",
      sessionId: "sess-two",
      sessionName: "two",
      content: [{ type: "text", text: "Second session." }],
    },
  });

  const methodOrder = calls.map((call) => call.method);
  assert.deepEqual(methodOrder, [
    "createForumTopic",
    "sendMessage",
    "deleteMessage",
    "closeForumTopic",
    "createForumTopic",
    "sendMessage",
  ]);
  assert.equal(calls[3].body.message_thread_id, 41);
  assert.equal(calls[4].body.name, "19700101_");
  assert.equal(calls[5].body.message_thread_id, 42);
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
      if (method === "deleteMessage") return true;
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

  assert.deepEqual(calls.map((call) => call.method), ["sendMessage", "sendMessage", "deleteMessage"]);
  assert.ok(calls.every((call) => !["createForumTopic", "closeForumTopic", "reopenForumTopic"].includes(call.method)));
  assert.ok(calls.every((call) => call.body.message_thread_id === undefined));
});

test("TelegramTraceConsumer reopens and reuses a closed topic when a session resumes", async () => {
  const calls = [];
  let messageId = 300;
  const dir = mkdtempSync(join(tmpdir(), "pi-trace-telegram-resume-"));
  const assetMapPath = join(dir, "pi-trace.assets.json");

  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(assetMapPath, JSON.stringify({
      sessions: {
        "sess-resume": {
          telegram: {
            chats: [
              {
                chatId: "-100456",
                topicName: "old-topic",
                messageThreadId: 77,
                topicCreated: true,
                topicClosed: true,
              },
            ],
          },
        },
      },
    }, null, 2) + "\n", "utf8");

    const consumer = new TelegramTraceConsumer({
      botToken: "test-token",
      chatIds: ["-100456"],
      assetMapPath,
      request: async (method, body) => {
        calls.push({ method, body });
        if (method === "reopenForumTopic") return true;
        if (method === "sendMessage") return { message_id: ++messageId };
        if (method === "closeForumTopic") return true;
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
        sessionId: "sess-resume",
        sessionName: "resume",
        content: [{ type: "text", text: "Back in the old topic." }],
      },
    });

    assert.deepEqual(calls.map((call) => call.method), ["reopenForumTopic", "sendMessage"]);
    assert.deepEqual(calls[0].body, { chat_id: "-100456", message_thread_id: 77 });
    assert.equal(calls[1].body.message_thread_id, 77);

    const assetMap = JSON.parse(readFileSync(assetMapPath, "utf8"));
    assert.deepEqual(assetMap.sessions["sess-resume"].telegram.chats, [
      { chatId: "-100456", topicName: "old-topic", messageThreadId: 77, topicCreated: true },
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("LarkTraceConsumer generates XML and calls lark-cli with correct arguments", async () => {
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
      content: "Run echo",
      sessionId: "sess-123",
      sessionName: "test-session",
      modelId: "gpt-4",
      modelProvider: "openai",
      cwd: "/test/workspace",
      userInput: "Run echo"
    },
  });

  consumer.consume({
    ...base,
    id: "m2",
    type: "message.record",
    payload: {
      role: "assistant",
      content: [
        { type: "text", text: "I will run the command." },
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
  assert.match(calloutCall.stdin, /<callout[^>]*>/);
  assert.match(calloutCall.stdin, /<b>Run ID:<\/b>.*run-lark/);
  assert.match(calloutCall.stdin, /<b>Session Name:<\/b>.*test-session/);
  assert.match(calloutCall.stdin, /<b>Model:<\/b>.*openai\/gpt-4/);

  // Fourth call: append content
  const appendCall = calls[3];
  assert.ok(appendCall.args.includes("+update"));
  assert.ok(appendCall.args.includes("--command"));
  assert.ok(appendCall.args.includes("append"));
  assert.ok(appendCall.args.includes("--doc"));
  assert.ok(appendCall.args.includes("doxcn-test-123"));
  assert.match(appendCall.stdin, /<h2>User<\/h2>/);
  assert.match(appendCall.stdin, /Run echo/);
  assert.match(appendCall.stdin, /<h2>Assistant<\/h2>/);
  assert.match(appendCall.stdin, /I will run the command/);
  assert.match(appendCall.stdin, /<h2>Tool Call: bash \(success\)<\/h2>/);
  assert.match(appendCall.stdin, /<pre lang="json"><code>.*command.*echo test.*<\/code><\/pre>/);
  assert.match(appendCall.stdin, /<pre lang="text"><code>test output<\/code><\/pre>/);

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
