import { loadSessionAssetMap, updateSessionAssetMap } from "../../assets/session-asset-map.js";
import type { TraceConsumer, TraceEvent } from "../../core/types.js";
import { safeJson } from "../../core/utils.js";
import { buildTraceTitle, deriveTraceTitleSubject, sanitizeTraceFileName } from "../title.js";

export interface TelegramTraceConsumerOptions {
  botToken: string;
  chatIds: string[];
  assetMapPath?: string;
  apiBaseUrl?: string;
  request?: TelegramRequest;
}

export type TelegramRequest = (method: string, body: Record<string, unknown>) => Promise<unknown>;

type TemporaryKind = "thinking" | "assistant" | "tool";

interface ChatState {
  topicAttempted: boolean;
  topicName?: string;
  messageThreadId?: number;
  topicClosed?: boolean;
  thinkingMessageIds: number[];
  assistantMessageIds: number[];
  toolMessageIds: number[];
  toolLines: string[];
}

interface TelegramMessageResult {
  message_id?: number;
}

interface TelegramTopicResult {
  message_thread_id?: number;
}

const MAX_MESSAGE_CHARS = 3900;
const MAX_TOOL_TEMP_CHARS = 3600;

export class TelegramTraceConsumer implements TraceConsumer {
  readonly name = "telegram";
  readonly filter = { kinds: ["batch" as const] };

  private readonly botToken: string;
  private readonly chatIds: string[];
  private readonly assetMapPath?: string;
  private readonly apiBaseUrl: string;
  private readonly requestOverride?: TelegramRequest;
  private readonly chatStates = new Map<string, ChatState>();
  private queue: Promise<void> = Promise.resolve();

  private initialized = false;
  private timestamp = Date.now();
  private runId = "unknown";
  private sessionName?: string;
  private sessionId?: string;
  private modelId?: string;
  private modelProvider?: string;
  private cwd?: string;
  private titleSubject?: string;
  private lastAssistantText = "";
  private turnToolCount = 0;

  constructor(options: TelegramTraceConsumerOptions) {
    this.botToken = options.botToken;
    this.chatIds = dedupe(options.chatIds.map(String).map((id) => id.trim()).filter(Boolean));
    this.assetMapPath = options.assetMapPath;
    this.apiBaseUrl = options.apiBaseUrl ?? "https://api.telegram.org";
    this.requestOverride = options.request;
  }

  consume(event: TraceEvent): Promise<void> {
    this.queue = this.queue
      .then(() => this.handleEvent(event))
      .catch((error: unknown) => {
        console.error("[trace:telegram] event handling failed", error);
      });
    return this.queue;
  }

  drain(): Promise<void> {
    return this.queue;
  }

  private async handleEvent(event: TraceEvent): Promise<void> {
    if (!this.botToken || this.chatIds.length === 0) return;
    await this.prepareSession(event);

    switch (event.type) {
      case "message.record":
        await this.handleMessageRecord(event.payload);
        break;
      case "tool.record":
        await this.handleToolRecord(event.payload);
        break;
      case "turn.record":
        await this.handleTurnRecord();
        break;
      case "agent.run":
        await this.handleAgentRun(event.payload);
        break;
    }
  }

  private async prepareSession(event: TraceEvent): Promise<void> {
    const incomingSessionId = stringValue(event.payload.sessionId);
    if (this.initialized && incomingSessionId && this.sessionId && incomingSessionId !== this.sessionId) {
      await this.closeCurrentSessionTopics();
      this.resetState();
    }
    this.ensureInitialized(event);
  }

  private ensureInitialized(event: TraceEvent): void {
    if (this.initialized) {
      this.captureMetadata(event.payload);
      return;
    }

    this.initialized = true;
    this.timestamp = event.timestamp;
    this.runId = String(event.runId ?? event.payload.runId ?? "unknown");
    this.captureMetadata(event.payload);
    this.restoreTelegramAssetMap();
  }

  private captureMetadata(payload: Record<string, unknown>): void {
    this.sessionName ??= stringValue(payload.sessionName);
    this.sessionId ??= stringValue(payload.sessionId);
    this.modelId ??= stringValue(payload.modelId);
    this.modelProvider ??= stringValue(payload.modelProvider);
    this.cwd ??= stringValue(payload.cwd);
    this.titleSubject ??= deriveTraceTitleSubject(payload);
  }

  private async handleMessageRecord(payload: Record<string, unknown>): Promise<void> {
    const role = String(payload.role ?? "unknown");
    if (role !== "assistant" || payload.toolCallId) return;

    const { thinking, text } = extractAssistantContent(payload.content);
    if (thinking) {
      await this.broadcastTemporary("thinking", `Thinking\n\n${thinking}`);
    }
    if (text) {
      this.lastAssistantText = text;
      await this.broadcastTemporary("assistant", text);
    }
  }

  private async handleToolRecord(payload: Record<string, unknown>): Promise<void> {
    this.turnToolCount += 1;
    const toolName = String(payload.toolName ?? "unknown");
    const input = renderReadableText(payload.input ?? null);
    const status = payload.isError ? " error" : "";
    const line = `[${toolName}${status}] ${input}`;

    for (const chatId of this.chatIds) {
      const state = this.getChatState(chatId);
      state.toolLines.push(line);
      let text = state.toolLines.join("\n");
      if (text.length > MAX_TOOL_TEMP_CHARS) {
        state.toolLines = [line];
        text = line;
      }
      await this.updateTemporary(chatId, "tool", text);
    }
  }

  private async handleTurnRecord(): Promise<void> {
    for (const chatId of this.chatIds) {
      await this.deleteTemporaryMessages(chatId);
      if (this.lastAssistantText.trim()) {
        await this.sendText(chatId, this.lastAssistantText);
      }
    }

    this.lastAssistantText = "";
    this.turnToolCount = 0;
  }

  private async handleAgentRun(payload: Record<string, unknown>): Promise<void> {
    this.captureMetadata(payload);
    const summary = this.formatRunSummary(payload);
    for (const chatId of this.chatIds) {
      await this.sendText(chatId, summary);
    }
    await this.closeCurrentSessionTopics();
    this.resetState();
  }

  private async broadcastTemporary(kind: TemporaryKind, text: string): Promise<void> {
    for (const chatId of this.chatIds) {
      await this.updateTemporary(chatId, kind, text);
    }
  }

  private async updateTemporary(chatId: string, kind: TemporaryKind, text: string): Promise<void> {
    const state = this.getChatState(chatId);
    const previousIds = this.getTemporaryMessageIds(state, kind);
    const chunks = splitTelegramText(text);
    const nextIds: number[] = [];

    for (let i = 0; i < chunks.length; i += 1) {
      const existingId = previousIds[i];
      if (existingId) {
        const edited = await this.tryTelegram("editMessageText", {
          chat_id: chatId,
          message_id: existingId,
          text: chunks[i],
        }, { ignoreDescriptions: ["message is not modified"] });

        if (edited.ok) {
          nextIds.push(existingId);
          continue;
        }
      }

      const sentId = await this.sendMessage(chatId, chunks[i]);
      if (sentId) nextIds.push(sentId);
    }

    for (const id of previousIds.slice(chunks.length)) {
      await this.deleteMessage(chatId, id);
    }

    this.setTemporaryMessageIds(state, kind, nextIds);
  }

  private async sendText(chatId: string, text: string): Promise<number[]> {
    const ids: number[] = [];
    for (const chunk of splitTelegramText(text)) {
      const id = await this.sendMessage(chatId, chunk);
      if (id) ids.push(id);
    }
    return ids;
  }

  private async sendMessage(chatId: string, text: string): Promise<number | undefined> {
    await this.ensureTopic(chatId);
    const state = this.getChatState(chatId);
    const body: Record<string, unknown> = {
      chat_id: chatId,
      text,
      disable_web_page_preview: true,
    };
    if (isTopicEligibleChat(chatId) && typeof state.messageThreadId === "number") {
      body.message_thread_id = state.messageThreadId;
    }

    const result = await this.tryTelegram("sendMessage", body);
    return messageId(result.result);
  }

  private async deleteTemporaryMessages(chatId: string): Promise<void> {
    const state = this.getChatState(chatId);
    const ids = [
      ...state.thinkingMessageIds,
      ...state.toolMessageIds,
      ...state.assistantMessageIds,
    ];

    for (const id of ids) {
      await this.deleteMessage(chatId, id);
    }

    state.thinkingMessageIds = [];
    state.toolMessageIds = [];
    state.assistantMessageIds = [];
    state.toolLines = [];
  }

  private async deleteMessage(chatId: string, messageIdValue: number): Promise<void> {
    await this.tryTelegram("deleteMessage", {
      chat_id: chatId,
      message_id: messageIdValue,
    }, {
      ignoreDescriptions: [
        "message to delete not found",
        "message can't be deleted",
        "message identifier is not specified",
      ],
    });
  }

  private async closeCurrentSessionTopics(): Promise<void> {
    for (const chatId of this.chatIds) {
      await this.deleteTemporaryMessages(chatId);
      await this.closeTopic(chatId);
    }
    this.updateTelegramAssetMap();
  }

  private async closeTopic(chatId: string): Promise<void> {
    if (!isTopicEligibleChat(chatId)) return;

    const state = this.getChatState(chatId);
    if (typeof state.messageThreadId !== "number" || state.topicClosed) return;

    const closed = await this.tryTelegram("closeForumTopic", {
      chat_id: chatId,
      message_thread_id: state.messageThreadId,
    }, {
      ignoreDescriptions: [
        "forum topic not found",
        "message thread not found",
        "chat not found",
        "topic is closed",
        "topic closed",
      ],
      logPrefix: `topic close failed for chat ${chatId}`,
    });
    if (closed.ok) state.topicClosed = true;
  }

  private async ensureTopic(chatId: string): Promise<void> {
    const state = this.getChatState(chatId);
    if (!isTopicEligibleChat(chatId)) {
      state.topicAttempted = true;
      return;
    }
    if (typeof state.messageThreadId === "number") {
      await this.reopenTopic(chatId);
      return;
    }
    if (state.topicAttempted) return;

    state.topicAttempted = true;
    state.topicName = this.deriveTopicName();
    const result = await this.tryTelegram("createForumTopic", {
      chat_id: chatId,
      name: state.topicName,
    }, {
      logPrefix: `topic create failed for chat ${chatId}`,
    });

    const threadId = messageThreadId(result.result);
    if (threadId) {
      state.messageThreadId = threadId;
    }
    this.updateTelegramAssetMap();
  }

  private async reopenTopic(chatId: string): Promise<void> {
    if (!isTopicEligibleChat(chatId)) return;

    const state = this.getChatState(chatId);
    if (typeof state.messageThreadId !== "number" || !state.topicClosed) return;

    const reopened = await this.tryTelegram("reopenForumTopic", {
      chat_id: chatId,
      message_thread_id: state.messageThreadId,
    }, {
      ignoreDescriptions: [
        "forum topic not found",
        "message thread not found",
        "chat not found",
        "topic is not closed",
        "topic not closed",
      ],
      logPrefix: `topic reopen failed for chat ${chatId}`,
    });
    if (reopened.ok) {
      state.topicClosed = false;
      this.updateTelegramAssetMap();
    }
  }

  private getChatState(chatId: string): ChatState {
    const existing = this.chatStates.get(chatId);
    if (existing) return existing;

    const created: ChatState = {
      topicAttempted: false,
      thinkingMessageIds: [],
      assistantMessageIds: [],
      toolMessageIds: [],
      toolLines: [],
    };
    this.chatStates.set(chatId, created);
    return created;
  }

  private getTemporaryMessageIds(state: ChatState, kind: TemporaryKind): number[] {
    if (kind === "thinking") return state.thinkingMessageIds;
    if (kind === "assistant") return state.assistantMessageIds;
    return state.toolMessageIds;
  }

  private setTemporaryMessageIds(state: ChatState, kind: TemporaryKind, ids: number[]): void {
    if (kind === "thinking") {
      state.thinkingMessageIds = ids;
      return;
    }
    if (kind === "assistant") {
      state.assistantMessageIds = ids;
      return;
    }
    state.toolMessageIds = ids;
  }

  private deriveTopicName(): string {
    const title = buildTraceTitle(this.timestamp, this.titleSubject);
    const sanitized = sanitizeTraceFileName(title) || "Pi_Trace";
    return sanitized.slice(0, 9) || "Pi_Trace";
  }

  private formatRunSummary(payload: Record<string, unknown>): string {
    const stats = (payload.stats ?? {}) as Record<string, unknown>;
    const lines = ["Run Summary", ""];

    lines.push(`Run ID: ${this.runId}`);
    if (this.sessionName) lines.push(`Session Name: ${this.sessionName}`);
    if (this.sessionId) lines.push(`Session ID: ${this.sessionId}`);

    const model = this.formatModel(payload);
    if (model) lines.push(`Model: ${model}`);
    if (this.cwd) lines.push(`Workspace: ${this.cwd}`);

    const usage = formatUsageLine(stats);
    if (usage) lines.push("", usage);

    const countParts: string[] = [];
    const turnCount = numberValue(stats.turnCount);
    const messageCount = numberValue(stats.messageCount);
    const toolCount = numberValue(stats.toolCount);
    const errorCount = numberValue(stats.errorCount);
    const durationMs = numberValue(stats.durationMs);
    if (turnCount !== undefined) countParts.push(`Turns: ${turnCount}`);
    if (messageCount !== undefined) countParts.push(`Messages: ${messageCount}`);
    if (toolCount !== undefined) countParts.push(`Tools: ${toolCount}`);
    if (errorCount !== undefined) countParts.push(`Errors: ${errorCount}`);
    if (durationMs !== undefined) countParts.push(`Duration: ${formatDuration(durationMs)}`);
    if (countParts.length > 0) lines.push(countParts.join(" | "));

    return lines.join("\n");
  }

  private formatModel(payload: Record<string, unknown>): string | undefined {
    if (this.modelId) return this.modelProvider ? `${this.modelProvider}/${this.modelId}` : this.modelId;
    const model = payload.model;
    if (!model || typeof model !== "object") return undefined;
    const record = model as Record<string, unknown>;
    const provider = stringValue(record.provider);
    const modelName = stringValue(record.model);
    if (!modelName) return undefined;
    return provider ? `${provider}/${modelName}` : modelName;
  }

  private updateTelegramAssetMap(): void {
    updateSessionAssetMap(this.assetMapPath, this.sessionId, {
      telegram: {
        chats: this.chatIds.map((chatId) => {
          const state = this.getChatState(chatId);
          return {
            chatId,
            ...(state.topicName ? { topicName: state.topicName } : {}),
            ...(typeof state.messageThreadId === "number" ? { messageThreadId: state.messageThreadId } : {}),
            topicCreated: typeof state.messageThreadId === "number",
            ...(state.topicClosed ? { topicClosed: true } : {}),
          };
        }),
      },
    });
  }

  private restoreTelegramAssetMap(): void {
    if (!this.assetMapPath || !this.sessionId) return;

    try {
      const entry = loadSessionAssetMap(this.assetMapPath).sessions[this.sessionId];
      for (const chat of entry?.telegram?.chats ?? []) {
        if (!this.chatIds.includes(chat.chatId)) continue;
        if (!isTopicEligibleChat(chat.chatId)) continue;
        const state = this.getChatState(chat.chatId);
        state.topicAttempted = Boolean(chat.topicCreated);
        state.topicName = chat.topicName;
        state.messageThreadId = typeof chat.messageThreadId === "number" ? chat.messageThreadId : undefined;
        state.topicClosed = Boolean(chat.topicClosed);
      }
    } catch (error) {
      console.warn(`[trace:telegram] failed to restore asset map ${this.assetMapPath}:`, error);
    }
  }

  private resetState(): void {
    this.chatStates.clear();
    this.initialized = false;
    this.timestamp = Date.now();
    this.runId = "unknown";
    this.sessionName = undefined;
    this.sessionId = undefined;
    this.modelId = undefined;
    this.modelProvider = undefined;
    this.cwd = undefined;
    this.titleSubject = undefined;
    this.lastAssistantText = "";
    this.turnToolCount = 0;
  }

  private async tryTelegram(
    method: string,
    body: Record<string, unknown>,
    options: { ignoreDescriptions?: string[]; logPrefix?: string } = {},
  ): Promise<{ ok: boolean; result?: unknown }> {
    try {
      return { ok: true, result: await this.callTelegram(method, body) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const normalizedMessage = message.toLowerCase();
      if (options.ignoreDescriptions?.some((description) => normalizedMessage.includes(description.toLowerCase()))) {
        return { ok: true };
      }
      console.error(`[trace:telegram] ${options.logPrefix ?? `${method} failed`}`, error);
      return { ok: false };
    }
  }

  protected async callTelegram(method: string, body: Record<string, unknown>): Promise<unknown> {
    if (this.requestOverride) return this.requestOverride(method, body);

    const response = await fetch(`${this.apiBaseUrl}/bot${this.botToken}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

    const text = await response.text();
    let json: Record<string, unknown> | undefined;
    try {
      json = text ? JSON.parse(text) as Record<string, unknown> : undefined;
    } catch {
      json = undefined;
    }

    if (!response.ok) {
      throw new Error(`Telegram ${method} HTTP ${response.status}: ${text.slice(0, 500)}`);
    }
    if (json && json.ok === false) {
      throw new Error(`Telegram ${method} error: ${String(json.description ?? text)}`);
    }
    return json?.result;
  }
}

function extractAssistantContent(content: unknown): { thinking: string; text: string } {
  if (typeof content === "string") return { thinking: "", text: content.trim() };
  if (!Array.isArray(content)) return { thinking: "", text: renderReadableText(content).trim() };

  const thinking: string[] = [];
  const text: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const item = block as Record<string, unknown>;
    if (item.type === "thinking") {
      const value = String(item.thinking ?? "").trim();
      if (value) thinking.push(value);
    } else if (item.type === "text") {
      const value = String(item.text ?? "").trim();
      if (value) text.push(value);
    }
  }
  return {
    thinking: thinking.join("\n\n"),
    text: text.join("\n\n"),
  };
}

function renderReadableText(value: unknown): string {
  if (typeof value === "string") return value;
  return safeJson(value);
}

function splitTelegramText(text: string): string[] {
  const normalized = text.trim();
  if (!normalized) return [];
  if (normalized.length <= MAX_MESSAGE_CHARS) return [normalized];

  const chunks: string[] = [];
  let remaining = normalized;
  while (remaining.length > 0) {
    if (remaining.length <= MAX_MESSAGE_CHARS) {
      chunks.push(remaining);
      break;
    }

    let splitAt = findSplitPoint(remaining, "\n\n");
    if (splitAt < 1) splitAt = findSplitPoint(remaining, "\n");
    if (splitAt < 1) splitAt = findSplitPoint(remaining, " ");
    if (splitAt < 1) splitAt = MAX_MESSAGE_CHARS;

    chunks.push(remaining.slice(0, splitAt).trimEnd());
    remaining = remaining.slice(splitAt).trimStart();
  }
  return chunks;
}

function findSplitPoint(text: string, separator: string): number {
  const splitAt = text.lastIndexOf(separator, MAX_MESSAGE_CHARS);
  return splitAt >= Math.floor(MAX_MESSAGE_CHARS * 0.5) ? splitAt + separator.length : -1;
}

function formatUsageLine(stats: Record<string, unknown>): string | undefined {
  const parts: string[] = [];
  const totalTokens = numberValue(stats.totalTokens);
  const inputTokens = numberValue(stats.inputTokens);
  const outputTokens = numberValue(stats.outputTokens);
  const cacheReadTokens = numberValue(stats.cacheReadTokens);
  const cost = numberValue(stats.cost);

  if (totalTokens !== undefined) parts.push(`Tokens: ${totalTokens}`);
  if (inputTokens !== undefined) {
    let input = `In: ${inputTokens}`;
    if (cacheReadTokens !== undefined && cacheReadTokens > 0) input += ` (cached ${cacheReadTokens})`;
    parts.push(input);
  }
  if (outputTokens !== undefined) parts.push(`Out: ${outputTokens}`);
  if (cost !== undefined && cost > 0) parts.push(`Cost: $${cost.toFixed(4)}`);

  return parts.length > 0 ? parts.join(" | ") : undefined;
}

function formatDuration(durationMs: number): string {
  if (durationMs < 1000) return `${durationMs}ms`;
  return `${(durationMs / 1000).toFixed(1)}s`;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function messageId(value: unknown): number | undefined {
  if (!value || typeof value !== "object") return undefined;
  const id = (value as TelegramMessageResult).message_id;
  return typeof id === "number" ? id : undefined;
}

function messageThreadId(value: unknown): number | undefined {
  if (!value || typeof value !== "object") return undefined;
  const id = (value as TelegramTopicResult).message_thread_id;
  return typeof id === "number" ? id : undefined;
}

function isTopicEligibleChat(chatId: string): boolean {
  return chatId.trim().startsWith("-");
}

function dedupe(values: string[]): string[] {
  return Array.from(new Set(values));
}
