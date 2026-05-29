export type TraceKind = "realtime" | "batch";
export type TraceFilterKind = TraceKind | "both";

export interface TraceConsumerFilter {
  kinds?: TraceFilterKind[];
}

export interface TraceConsumer {
  name: string;
  filter?: TraceConsumerFilter;
  consume(event: TraceEvent): void | Promise<void>;
}

export interface TraceEvent<TPayload extends Record<string, unknown> = Record<string, unknown>> {
  id: string;
  kind: TraceKind;
  type: string;
  timestamp: number;
  runId?: string;
  payload: TPayload;
}

export type MessageRole = "user" | "assistant" | "toolResult" | string;
export type MessageBlockType = "thinking" | "text";

export interface AgentRunStats {
  turnCount: number;
  messageCount: number;
  toolCount: number;
  errorCount: number;
  durationMs: number;
}

export interface PendingToolRecord {
  toolCallId: string;
  toolName: string;
  startedAt: number;
  args?: unknown;
  input?: unknown;
  resultContent?: unknown;
  details?: unknown;
  isError?: boolean;
}

export interface CurrentAgentRun {
  runId: string;
  input?: string;
  startedAt: number;
  turnCount: number;
  messageCount: number;
  toolCount: number;
  errorCount: number;
  pendingTools: Map<string, PendingToolRecord>;
  turnStartedAt: Map<number, number>;
  eventIds: string[];
  sessionId?: string;
  sessionName?: string;
  modelId?: string;
  modelName?: string;
  modelProvider?: string;
  cwd?: string;
}
