import test from "node:test";
import assert from "node:assert/strict";

import { TraceCore, matchesTraceFilter, TraceProducer } from "../dist/index.js";

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
