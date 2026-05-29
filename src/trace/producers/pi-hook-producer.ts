import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { CurrentAgentRun, PendingToolRecord, TraceEvent, TraceKind } from "../core/types.js";
import { contentToPreview, extractMessageDelta, getModelFromMessages, messageContent, messageRole } from "../core/utils.js";
import { TraceCore } from "../core/trace-core.js";

export interface TraceProducerOptions {
  now?: () => number;
  runIdFactory?: () => string;
  eventIdFactory?: (runId: string, sequence: number) => string;
}

export class TraceProducer {
  private readonly now: () => number;
  private readonly runIdFactory: () => string;
  private readonly eventIdFactory: (runId: string, sequence: number) => string;
  private run?: CurrentAgentRun;
  private lastInput?: string;
  private sequence = 0;

  constructor(private readonly core: TraceCore, options: TraceProducerOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.runIdFactory = options.runIdFactory ?? (() => `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);
    this.eventIdFactory = options.eventIdFactory ?? ((runId, sequence) => `${runId}-event-${sequence}`);
  }

  register(pi: ExtensionAPI): void {
    pi.on("input", (event) => this.handleInput(event));
    pi.on("before_agent_start", (event) => this.handleBeforeAgentStart(event));
    pi.on("agent_start", (event) => this.handleAgentStart(event));
    pi.on("agent_end", (event) => this.handleAgentEnd(event));
    pi.on("turn_start", (event) => this.handleTurnStart(event));
    pi.on("turn_end", (event) => this.handleTurnEnd(event));
    pi.on("message_start", (event) => this.handleMessageStart(event));
    pi.on("message_update", (event) => this.handleMessageUpdate(event));
    pi.on("message_end", (event) => this.handleMessageEnd(event));
    pi.on("tool_execution_start", (event) => this.handleToolExecutionStart(event));
    pi.on("tool_call", (event) => this.handleToolCall(event));
    pi.on("tool_result", (event) => this.handleToolResult(event));
    pi.on("tool_execution_end", (event) => this.handleToolExecutionEnd(event));
  }

  handleInput(event: any): void {
    if (typeof event?.text === "string") this.lastInput = event.text;
  }

  handleBeforeAgentStart(event: any): void {
    if (typeof event?.prompt === "string") this.lastInput = event.prompt;
  }

  handleAgentStart(_event: any): void {
    this.sequence = 0;
    const runId = this.runIdFactory();
    this.run = {
      runId,
      input: this.lastInput,
      startedAt: this.now(),
      turnCount: 0,
      messageCount: 0,
      toolCount: 0,
      errorCount: 0,
      pendingTools: new Map<string, PendingToolRecord>(),
      turnStartedAt: new Map<number, number>(),
      eventIds: [],
    };
  }

  handleAgentEnd(event: any): void {
    const run = this.ensureRun();
    const model = getModelFromMessages(event?.messages);
    this.publish("batch", "agent.run", {
      input: run.input,
      model,
      stats: {
        turnCount: run.turnCount,
        messageCount: run.messageCount,
        toolCount: run.toolCount,
        errorCount: run.errorCount,
        durationMs: this.now() - run.startedAt,
      },
      eventIds: [...run.eventIds],
    }, { recordBatchId: false });
    this.run = undefined;
  }

  handleTurnStart(event: any): void {
    const run = this.ensureRun();
    const turnIndex = Number(event?.turnIndex ?? run.turnCount);
    run.turnStartedAt.set(turnIndex, this.now());
    this.publish("realtime", "turn.started", { turnIndex });
  }

  handleTurnEnd(event: any): void {
    const run = this.ensureRun();
    const turnIndex = Number(event?.turnIndex ?? run.turnCount);
    run.turnCount = Math.max(run.turnCount, turnIndex + 1);
    const startedAt = run.turnStartedAt.get(turnIndex) ?? this.now();
    this.publish("realtime", "turn.ended", { turnIndex });
    this.publish("batch", "turn.record", {
      turnIndex,
      durationMs: this.now() - startedAt,
    });
  }

  handleMessageStart(event: any): void {
    this.ensureRun();
    this.publish("realtime", "message.started", {
      role: messageRole(event?.message),
    });
  }

  handleMessageUpdate(event: any): void {
    this.ensureRun();
    const delta = extractMessageDelta(event?.assistantMessageEvent);
    if (!delta) return;
    this.publish("realtime", "message.delta", delta);
  }

  handleMessageEnd(event: any): void {
    const run = this.ensureRun();
    const message = event?.message;
    const role = messageRole(message);
    const payload: Record<string, unknown> = {
      role,
      content: messageContent(message),
      contentPreview: contentToPreview(messageContent(message)),
    };
    if (message?.toolCallId) payload.toolCallId = message.toolCallId;
    if (message?.toolName) payload.toolName = message.toolName;
    if (typeof message?.isError === "boolean") payload.isError = message.isError;

    this.publish("realtime", "message.ended", { role });
    this.publish("batch", "message.record", payload);
    run.messageCount += 1;
  }

  handleToolExecutionStart(event: any): void {
    const run = this.ensureRun();
    const toolCallId = String(event?.toolCallId ?? "unknown");
    const toolName = String(event?.toolName ?? "unknown");
    run.pendingTools.set(toolCallId, {
      toolCallId,
      toolName,
      startedAt: this.now(),
      args: event?.args,
    });
    this.publish("realtime", "tool.started", {
      toolName,
      toolCallId,
      args: event?.args,
    });
  }

  handleToolCall(event: any): void {
    const tool = this.getOrCreatePendingTool(event);
    tool.input = event?.input;
  }

  handleToolResult(event: any): void {
    const tool = this.getOrCreatePendingTool(event);
    tool.input = event?.input ?? tool.input;
    tool.resultContent = event?.content;
    tool.details = event?.details;
    tool.isError = Boolean(event?.isError);
    this.publish("realtime", "tool.result", {
      toolName: tool.toolName,
      toolCallId: tool.toolCallId,
      contentPreview: contentToPreview(event?.content),
      isError: tool.isError,
    });
  }

  handleToolExecutionEnd(event: any): void {
    const run = this.ensureRun();
    const tool = this.getOrCreatePendingTool(event);
    tool.resultContent ??= event?.result?.content ?? event?.result;
    tool.details ??= event?.result?.details;
    tool.isError ??= Boolean(event?.isError);

    this.publish("realtime", "tool.ended", {
      toolName: tool.toolName,
      toolCallId: tool.toolCallId,
    });
    this.publish("batch", "tool.record", {
      toolName: tool.toolName,
      toolCallId: tool.toolCallId,
      input: tool.input ?? tool.args,
      resultContent: tool.resultContent,
      resultPreview: contentToPreview(tool.resultContent),
      details: tool.details,
      isError: Boolean(tool.isError),
      durationMs: this.now() - tool.startedAt,
    });

    run.toolCount += 1;
    if (tool.isError) run.errorCount += 1;
    run.pendingTools.delete(tool.toolCallId);
  }

  private getOrCreatePendingTool(event: any): PendingToolRecord {
    const run = this.ensureRun();
    const toolCallId = String(event?.toolCallId ?? "unknown");
    const existing = run.pendingTools.get(toolCallId);
    if (existing) return existing;
    const tool: PendingToolRecord = {
      toolCallId,
      toolName: String(event?.toolName ?? "unknown"),
      startedAt: this.now(),
    };
    run.pendingTools.set(toolCallId, tool);
    return tool;
  }

  private ensureRun(): CurrentAgentRun {
    if (!this.run) this.handleAgentStart({});
    return this.run!;
  }

  private publish(kind: TraceKind, type: string, payload: Record<string, unknown>, options: { recordBatchId?: boolean } = {}): TraceEvent {
    const run = this.ensureRun();
    const event: TraceEvent = {
      id: this.eventIdFactory(run.runId, ++this.sequence),
      kind,
      type,
      timestamp: this.now(),
      runId: run.runId,
      payload,
    };
    if (kind === "batch" && options.recordBatchId !== false) run.eventIds.push(event.id);
    this.core.publish(event);
    return event;
  }
}
