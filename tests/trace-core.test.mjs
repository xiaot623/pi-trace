import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MarkdownTraceConsumer, TraceCore, matchesTraceFilter, resolveTraceConsumerConfig, TraceProducer } from "../dist/index.js";

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
  const outputPath = join(dir, "trace.md");

  try {
    const consumer = new MarkdownTraceConsumer({ outputPath });
    const base = { kind: "batch", timestamp: 1, runId: "run-md" };

    consumer.consume({
      ...base,
      id: "m1",
      type: "message.record",
      payload: { role: "user", content: "Run echo" },
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

    const markdown = readFileSync(outputPath, "utf8");
    assert.match(markdown, /^# Pi Trace/m);
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
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});


test("resolveTraceConsumerConfig chooses environment-specific default asset directories", () => {
  const now = new Date("2026-05-29T12:34:56.789Z");

  const dev = resolveTraceConsumerConfig({ env: {}, cwd: "/repo", homeDir: "/home/me", now });
  assert.equal(dev.mode, "development");
  assert.equal(dev.assetDir, "/repo/dev_assets");
  assert.equal(dev.console.enabled, true);
  assert.equal(dev.markdown.enabled, true);
  assert.equal(dev.markdown.outputPath, "/repo/dev_assets/markdown/trace-2026-05-29T12-34-56-789Z.md");

  const prod = resolveTraceConsumerConfig({ env: { NODE_ENV: "production" }, cwd: "/repo", homeDir: "/home/me", now });
  assert.equal(prod.mode, "production");
  assert.equal(prod.assetDir, "/home/me/.pi-trace");
  assert.equal(prod.markdown.outputPath, "/home/me/.pi-trace/markdown/trace-2026-05-29T12-34-56-789Z.md");

  const overridden = resolveTraceConsumerConfig({
    env: {
      PI_TRACE_MODE: "production",
      PI_TRACE_ASSET_DIR: "/custom/assets",
      PI_TRACE_MARKDOWN_PATH: "/custom/trace.md",
      PI_TRACE_CONSOLE_ENABLED: "false",
      PI_TRACE_MARKDOWN_ENABLED: "false",
    },
    cwd: "/repo",
    homeDir: "/home/me",
    now,
  });
  assert.equal(overridden.mode, "production");
  assert.equal(overridden.assetDir, "/custom/assets");
  assert.equal(overridden.console.enabled, false);
  assert.equal(overridden.markdown.enabled, false);
  assert.equal(overridden.markdown.outputPath, "/custom/trace.md");
});
