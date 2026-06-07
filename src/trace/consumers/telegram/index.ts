import { loadSessionAssetMap, updateSessionAssetMap } from "../../assets/session-asset-map.js";
import type { TraceConsumer, TraceEvent } from "../../core/types.js";
import { logger } from "../../core/logger.js";
import { safeJson } from "../../core/utils.js";
import { buildSubjectFirstTitle, deriveTraceTitleSubject } from "../title.js";
import { overrides } from "../../flags.js";

export interface TelegramTraceConsumerOptions {
  botToken: string;
  chatIds: string[];
  assetMapPath?: string;
  apiBaseUrl?: string;
  request?: TelegramRequest;
}

export type TelegramRequest = (method: string, body: Record<string, unknown>) => Promise<unknown>;

type TelegramMessageKind = "thinking" | "tool" | "assistant" | "summary";

interface ChatState {
  topicAttempted: boolean;
  topicName?: string;
  messageThreadId?: number;
  topicCreated?: boolean;
  thinkingMessageIds: number[];
  toolMessageIds: number[];
  assistantMessageIds: number[];
  summaryMessageIds: number[];
  thinkingText: string;
  assistantText: string;
  toolLines: string[];
  toolCardTexts: string[];
  toolSequenceOpen: boolean;
}

interface TelegramMessageResult {
  message_id?: number;
}

interface TelegramTopicResult {
  message_thread_id?: number;
}

interface TelegramTotals {
  loops: number;
  turnCount: number;
  messageCount: number;
  toolCount: number;
  errorCount: number;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  cost: number;
}

const MAX_MESSAGE_CHARS = 3900;
const MAX_TOOL_TEMP_CHARS = 3600;
const MAX_TOOL_LINE_CHARS = 220;

export class TelegramTraceConsumer implements TraceConsumer {
  readonly name = "telegram";
  readonly filter = { kinds: ["batch" as const] };

  private botToken: string;
  private chatIds: string[];
  private readonly configuredBotToken: string;
  private readonly configuredChatIds: string[];
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
  private totals: TelegramTotals = createEmptyTotals();
  private readonly totalsByKey = new Map<string, TelegramTotals>();

  constructor(options: TelegramTraceConsumerOptions) {
    this.configuredBotToken = options.botToken;
    this.configuredChatIds = dedupe(options.chatIds.map(String).map((id) => id.trim()).filter(Boolean));
    this.botToken = this.configuredBotToken;
    this.chatIds = this.configuredChatIds;
    this.assetMapPath = options.assetMapPath;
    this.apiBaseUrl = options.apiBaseUrl ?? "https://api.telegram.org";
    this.requestOverride = options.request;
  }

  consume(event: TraceEvent): Promise<void> {
    this.queue = this.queue
      .then(() => this.handleEvent(event))
      .catch((error: unknown) => {
        logger.error("[trace:telegram] event handling failed", error);
      });
    return this.queue;
  }

  drain(): Promise<void> {
    return this.queue;
  }

  private async handleEvent(event: TraceEvent): Promise<void> {
    this.refreshRuntimeCredentials();
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
        break;
      case "agent.run":
        await this.handleAgentRun(event.payload);
        break;
    }
  }

  private refreshRuntimeCredentials(): void {
    const envToken = process.env.PI_TRACE_TELEGRAM_BOT_TOKEN?.trim();
    const envChatIds = parseRuntimeChatIds(process.env.PI_TRACE_TELEGRAM_CHAT_IDS);
    if (envToken && envChatIds) {
      this.botToken = envToken;
      this.chatIds = envChatIds;
      return;
    }
    this.botToken = this.configuredBotToken;
    this.chatIds = this.configuredChatIds;
  }

  private async prepareSession(event: TraceEvent): Promise<void> {
    const incomingSessionId = stringValue(event.payload.sessionId);
    if (this.initialized && incomingSessionId && this.sessionId && incomingSessionId !== this.sessionId) {
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
    if (text) this.lastAssistantText = text;

    for (const chatId of this.chatIds) {
      await this.ensureTopic(chatId);
      const state = this.getChatState(chatId);
      if (this.usesOrderedTopicMode(chatId)) {
        this.resetTopicToolSequence(state);
        if (thinking) await this.sendText(chatId, "thinking", thinking);
        if (text) await this.sendText(chatId, "assistant", text);
        continue;
      }

      if (thinking) {
        state.thinkingText = thinking;
        await this.updateProgress(chatId, "thinking", false);
      }
      if (text) {
        state.assistantText = text;
        await this.updateProgress(chatId, "assistant", false);
      }
    }
  }

  private async handleToolRecord(payload: Record<string, unknown>): Promise<void> {
    const toolName = String(payload.toolName ?? "unknown");
    const input = renderToolInput(payload.input ?? null);
    const status = payload.isError ? " error" : "";
    const line = oneLine(`[${toolName}${status}] ${input}`, MAX_TOOL_LINE_CHARS);

    for (const chatId of this.chatIds) {
      await this.ensureTopic(chatId);
      const state = this.getChatState(chatId);
      if (this.usesOrderedTopicMode(chatId)) {
        await this.appendTopicToolLine(chatId, line);
        continue;
      }

      state.toolLines.push(line);
      if (state.toolLines.join("\n").length > MAX_TOOL_TEMP_CHARS) {
        state.toolLines = [line];
      }
      await this.updateProgress(chatId, "tool", false);
    }
  }

  private async handleAgentRun(payload: Record<string, unknown>): Promise<void> {
    this.captureMetadata(payload);
    this.totals = accumulateTotals(this.totals, (payload.stats ?? {}) as Record<string, unknown>);
    this.updateTelegramAssetMap();
    for (const chatId of this.chatIds) {
      await this.ensureTopic(chatId);
      if (this.lastAssistantText.trim() && !this.usesOrderedTopicMode(chatId)) {
        await this.updateProgress(chatId, "assistant", true);
      }
    }

    const summary = this.formatRunSummary(payload);
    for (const chatId of this.chatIds) {
      const state = this.getChatState(chatId);
      const previousSummaryIds = [...state.summaryMessageIds];
      const summaryIds = await this.sendText(chatId, "summary", summary);
      state.summaryMessageIds = summaryIds;
      this.updateTelegramAssetMap();
      await this.deleteMessageIds(chatId, previousSummaryIds);
      if (this.usesOrderedTopicMode(chatId)) {
        this.resetTopicToolSequence(state);
      } else {
        await this.deleteProgressMessages(chatId, ["thinking", "tool"]);
      }
    }
    this.resetState();
  }

  private async broadcastProgress(kind: TelegramMessageKind, update: (state: ChatState) => void): Promise<void> {
    for (const chatId of this.chatIds) {
      update(this.getChatState(chatId));
      await this.updateProgress(chatId, kind, false);
    }
  }

  private async updateProgress(chatId: string, kind: TelegramMessageKind, final: boolean): Promise<void> {
    const state = this.getChatState(chatId);
    const previousIds = getProgressMessageIds(state, kind);
    const text = renderProgressText(state, kind, final);
    const chunks = splitTelegramText(text).map((chunk, index, all) => formatTelegramMessage(kind, chunk, index, all.length));
    const nextIds: number[] = [];

    for (let i = 0; i < chunks.length; i += 1) {
      const existingId = previousIds[i];
      if (existingId) {
        const edited = await this.tryTelegram("editMessageText", {
          chat_id: chatId,
          message_id: existingId,
          text: chunks[i],
          parse_mode: "HTML",
          disable_web_page_preview: true,
        }, { ignoreDescriptions: ["message is not modified"] });

        if (edited.ok) {
          nextIds.push(existingId);
          continue;
        }
      }

      const sentId = await this.sendMessage(chatId, chunks[i]);
      if (sentId) {
        nextIds.push(sentId);
        if (existingId) await this.deleteMessageIds(chatId, [existingId], { logFailures: true });
      } else if (existingId) {
        nextIds.push(existingId);
      }
    }

    for (let i = chunks.length; i < previousIds.length; i += 1) {
      await this.deleteMessageIds(chatId, [previousIds[i]], { logFailures: true });
    }

    setProgressMessageIds(state, kind, nextIds);
  }

  private async sendText(chatId: string, kind: TelegramMessageKind, text: string): Promise<number[]> {
    const ids: number[] = [];
    const chunks = splitTelegramText(text).map((chunk, index, all) => formatTelegramMessage(kind, chunk, index, all.length));
    for (const chunk of chunks) {
      const id = await this.sendMessage(chatId, chunk);
      if (id) ids.push(id);
    }
    return ids;
  }

  private usesOrderedTopicMode(chatId: string): boolean {
    const state = this.getChatState(chatId);
    return isTopicEligibleChat(chatId) && typeof state.messageThreadId === "number";
  }

  private resetTopicToolSequence(state: ChatState): void {
    state.toolLines = [];
    state.toolMessageIds = [];
    state.toolCardTexts = [];
    state.toolSequenceOpen = false;
  }

  private async appendTopicToolLine(chatId: string, line: string): Promise<void> {
    const state = this.getChatState(chatId);
    if (!state.toolSequenceOpen) {
      state.toolSequenceOpen = true;
      state.toolMessageIds = [];
      state.toolCardTexts = [];
    }

    const lastIndex = state.toolCardTexts.length - 1;
    const lastText = lastIndex >= 0 ? state.toolCardTexts[lastIndex] : "";
    const nextText = lastText ? `${lastText}\n${line}` : line;
    if (!lastText || nextText.length > MAX_TOOL_TEMP_CHARS) {
      const [messageId] = await this.sendText(chatId, "tool", line);
      if (messageId) {
        state.toolMessageIds.push(messageId);
        state.toolCardTexts.push(line);
      }
      return;
    }

    const existingId = state.toolMessageIds[lastIndex];
    const formatted = formatTelegramMessage("tool", nextText);
    if (existingId) {
      const edited = await this.tryTelegram("editMessageText", {
        chat_id: chatId,
        message_id: existingId,
        text: formatted,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }, { ignoreDescriptions: ["message is not modified"] });
      if (edited.ok) {
        state.toolCardTexts[lastIndex] = nextText;
        return;
      }
    }

    const replacementId = await this.sendMessage(chatId, formatted);
    if (!replacementId) return;
    if (lastIndex >= 0) state.toolCardTexts[lastIndex] = nextText;
    if (existingId) {
      state.toolMessageIds[lastIndex] = replacementId;
      await this.deleteMessageIds(chatId, [existingId], { logFailures: true });
      return;
    }
    if (lastIndex >= 0) {
      state.toolMessageIds[lastIndex] = replacementId;
      return;
    }
    state.toolCardTexts.push(nextText);
    state.toolMessageIds.push(replacementId);
  }

  private async sendMessage(chatId: string, text: string): Promise<number | undefined> {
    await this.ensureTopic(chatId);
    const state = this.getChatState(chatId);
    const body: Record<string, unknown> = {
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    };
    if (isTopicEligibleChat(chatId) && typeof state.messageThreadId === "number") {
      body.message_thread_id = state.messageThreadId;
    }

    const result = await this.tryTelegram("sendMessage", body);
    return messageId(result.result);
  }

  private async deleteProgressMessages(chatId: string, kinds: TelegramMessageKind[]): Promise<void> {
    const state = this.getChatState(chatId);
    const ids = kinds.flatMap((kind) => getProgressMessageIds(state, kind));
    await this.deleteMessageIds(chatId, ids);

    for (const kind of kinds) {
      setProgressMessageIds(state, kind, []);
    }
  }

  private async deleteMessageIds(chatId: string, ids: number[], options: { logFailures?: boolean } = {}): Promise<void> {
    for (const id of ids) {
      await this.tryTelegram("deleteMessage", {
        chat_id: chatId,
        message_id: id,
      }, options.logFailures ? {
        logPrefix: `replacement message cleanup failed for chat ${chatId}`,
      } : {
        ignoreDescriptions: [
          "message to delete not found",
          "message can't be deleted",
          "message identifier is not specified",
        ],
      });
    }
  }

  private async ensureTopic(chatId: string): Promise<void> {
    const state = this.getChatState(chatId);
    if (!isTopicEligibleChat(chatId)) {
      state.topicAttempted = true;
      return;
    }
    if (typeof state.messageThreadId === "number") return;
    if (state.topicAttempted) return;

    state.topicAttempted = true;

    // If --topic flag provided an existing thread id, use it directly.
    const existingThreadId = parseThreadId(overrides.telegramThreadId);
    if (existingThreadId !== undefined) {
      state.messageThreadId = existingThreadId;
      state.topicName = "(external)";
      state.topicCreated = false;
      this.updateTelegramAssetMap();
      return;
    }

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
      state.topicCreated = true;
    }
    this.updateTelegramAssetMap();
  }

  private getChatState(chatId: string): ChatState {
    const existing = this.chatStates.get(chatId);
    if (existing) return existing;

    const created: ChatState = {
      topicAttempted: false,
      thinkingMessageIds: [],
      toolMessageIds: [],
      assistantMessageIds: [],
      summaryMessageIds: [],
      thinkingText: "",
      assistantText: "",
      toolLines: [],
      toolCardTexts: [],
      toolSequenceOpen: false,
    };
    this.chatStates.set(chatId, created);
    return created;
  }

  private deriveTopicName(): string {
    return buildSubjectFirstTitle(this.timestamp, this.titleSubject).slice(0, 128);
  }

  private totalsKey(): string {
    return this.sessionId ?? this.runId;
  }

  private formatRunSummary(payload: Record<string, unknown>): string {
    const stats = this.totals;
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
    countParts.push(`Turns: ${stats.turnCount}`);
    countParts.push(`Loops: ${stats.loops}`);
    countParts.push(`Messages: ${stats.messageCount}`);
    countParts.push(`Tools: ${stats.toolCount}`);
    countParts.push(`Errors: ${stats.errorCount}`);
    countParts.push(`Duration: ${formatDuration(stats.durationMs)}`);
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
    this.totalsByKey.set(this.totalsKey(), this.totals);
    updateSessionAssetMap(this.assetMapPath, this.sessionId, {
      telegram: {
        chats: this.chatIds.map((chatId) => {
          const state = this.getChatState(chatId);
          return {
            chatId,
            ...(state.topicName ? { topicName: state.topicName } : {}),
            ...(typeof state.messageThreadId === "number" ? { messageThreadId: state.messageThreadId } : {}),
            topicCreated: Boolean(state.topicCreated),

            ...(state.summaryMessageIds.length > 0 ? { summaryMessageIds: state.summaryMessageIds } : {}),
          };
        }),
        totals: this.totals,
      },
    });
  }

  private restoreTelegramAssetMap(): void {
    if (!this.sessionId) return;
    if (!this.assetMapPath) {
      this.totals = normalizeTotals(this.totalsByKey.get(this.totalsKey()));
      return;
    }

    try {
      const entry = loadSessionAssetMap(this.assetMapPath).sessions[this.sessionId];
      this.totals = normalizeTotals(entry?.telegram?.totals ?? this.totalsByKey.get(this.totalsKey()));
      this.totalsByKey.set(this.totalsKey(), this.totals);
      for (const chat of entry?.telegram?.chats ?? []) {
        if (!this.chatIds.includes(chat.chatId)) continue;
        const state = this.getChatState(chat.chatId);
        state.summaryMessageIds = Array.isArray(chat.summaryMessageIds)
          ? chat.summaryMessageIds.filter((id) => typeof id === "number" && Number.isFinite(id))
          : [];
        if (!isTopicEligibleChat(chat.chatId)) continue;

        // Flag override always wins over persisted state.
        const flagThreadId = parseThreadId(overrides.telegramThreadId);
        if (flagThreadId !== undefined) {
          state.topicAttempted = true;
          state.topicName = "(external)";
          state.messageThreadId = flagThreadId;
          state.topicCreated = false;
          continue;
        }

        state.topicAttempted = Boolean(chat.topicCreated || typeof chat.messageThreadId === "number");
        state.topicName = chat.topicName;
        state.messageThreadId = typeof chat.messageThreadId === "number" ? chat.messageThreadId : undefined;
        state.topicCreated = Boolean(chat.topicCreated);

      }
    } catch (error) {
      logger.warn(`[trace:telegram] failed to restore asset map ${this.assetMapPath}:`, error);
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
    this.totals = createEmptyTotals();
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
      logger.error(`[trace:telegram] ${options.logPrefix ?? `${method} failed`}`, error);
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

function parseRuntimeChatIds(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const ids = dedupe(value.split(",").map((id) => id.trim()).filter(Boolean));
  return ids.length > 0 ? ids : undefined;
}

function renderReadableText(value: unknown): string {
  if (typeof value === "string") return value;
  return safeJson(value);
}

function renderProgressText(state: ChatState, kind: TelegramMessageKind, final: boolean): string {
  if (kind === "thinking") return state.thinkingText.trim();
  if (kind === "tool") return state.toolLines.join("\n").trim();
  if (kind === "assistant") {
    if (final && state.assistantText.trim()) return state.assistantText.trim();
    return state.assistantText.trim();
  }
  return "";
}

function getProgressMessageIds(state: ChatState, kind: TelegramMessageKind): number[] {
  if (kind === "thinking") return state.thinkingMessageIds;
  if (kind === "tool") return state.toolMessageIds;
  if (kind === "assistant") return state.assistantMessageIds;
  return [];
}

function setProgressMessageIds(state: ChatState, kind: TelegramMessageKind, ids: number[]): void {
  if (kind === "thinking") {
    state.thinkingMessageIds = ids;
    return;
  }
  if (kind === "tool") {
    state.toolMessageIds = ids;
    return;
  }
  if (kind === "assistant") {
    state.assistantMessageIds = ids;
  }
}

function renderToolInput(value: unknown): string {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return renderReadableText(value);

  const record = value as Record<string, unknown>;
  const command = stringValue(record.command);
  if (command) return command;

  const args = stringValue(record.args);
  if (args) return args;

  return renderReadableText(value);
}

function oneLine(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 1))}…`;
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

function formatTelegramMessage(kind: TelegramMessageKind, text: string, index = 0, total = 1): string {
  const label = telegramKindLabel(kind);
  const suffix = total > 1 ? ` ${index + 1}/${total}` : "";
  const body = renderTelegramHtml(text);
  return `${label.icon} <b>${escapeHtml(label.title)}${suffix}</b>${body ? `\n\n${body}` : ""}`;
}

function telegramKindLabel(kind: TelegramMessageKind): { icon: string; title: string } {
  if (kind === "thinking") return { icon: "💭", title: "Thinking" };
  if (kind === "tool") return { icon: "🛠", title: "Tool Call" };
  if (kind === "summary") return { icon: "📊", title: "Run Summary" };
  return { icon: "🤖", title: "Assistant" };
}

function renderTelegramHtml(text: string): string {
  const segments = splitMarkdownCodeFences(text.trim());
  return segments.map((segment) => {
    if (segment.kind === "code") {
      const languageClass = segment.language ? ` class="language-${escapeHtmlAttribute(segment.language)}"` : "";
      return `<pre><code${languageClass}>${escapeHtml(segment.value)}</code></pre>`;
    }
    return renderInlineMarkdownHtml(segment.value);
  }).join("");
}

function splitMarkdownCodeFences(text: string): Array<{ kind: "text" | "code"; value: string; language?: string }> {
  const segments: Array<{ kind: "text" | "code"; value: string; language?: string }> = [];
  const fencePattern = /```([^\n`]*)\n?([\s\S]*?)```/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = fencePattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ kind: "text", value: text.slice(lastIndex, match.index) });
    }
    segments.push({
      kind: "code",
      language: match[1]?.trim(),
      value: match[2] ?? "",
    });
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) {
    segments.push({ kind: "text", value: text.slice(lastIndex) });
  }
  return segments;
}

function renderInlineMarkdownHtml(text: string): string {
  const lines = text.split("\n").map((line) => {
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) return `<b>${renderInlineMarkdownTokens(heading[2])}</b>`;
    return renderInlineMarkdownTokens(line);
  });
  return lines.join("\n");
}

function renderInlineMarkdownTokens(text: string): string {
  const placeholders: string[] = [];
  let protectedText = text;

  protectedText = protectedText.replace(/`([^`\n]+)`/g, (_match, code: string) => {
    const token = `\u0000${placeholders.length}\u0000`;
    placeholders.push(`<code>${escapeHtml(code)}</code>`);
    return token;
  });

  protectedText = protectedText.replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, (_match, label: string, url: string) => {
    const token = `\u0000${placeholders.length}\u0000`;
    placeholders.push(`<a href="${escapeHtmlAttribute(url)}">${escapeHtml(label)}</a>`);
    return token;
  });

  let escaped = escapeHtml(protectedText);
  escaped = escaped.replace(/\*\*([^*\n][\s\S]*?[^*\n])\*\*/g, "<b>$1</b>");

  return escaped.replace(/\u0000(\d+)\u0000/g, (_match, index: string) => placeholders[Number(index)] ?? "");
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeHtmlAttribute(value: string): string {
  return escapeHtml(value).replace(/"/g, "&quot;");
}

function createEmptyTotals(): TelegramTotals {
  return {
    loops: 0,
    turnCount: 0,
    messageCount: 0,
    toolCount: 0,
    errorCount: 0,
    durationMs: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    cost: 0,
  };
}

function normalizeTotals(value: unknown): TelegramTotals {
  const record = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return {
    loops: numberValue(record.loops) ?? 0,
    turnCount: numberValue(record.turnCount) ?? 0,
    messageCount: numberValue(record.messageCount) ?? 0,
    toolCount: numberValue(record.toolCount) ?? 0,
    errorCount: numberValue(record.errorCount) ?? 0,
    durationMs: numberValue(record.durationMs) ?? 0,
    inputTokens: numberValue(record.inputTokens) ?? 0,
    outputTokens: numberValue(record.outputTokens) ?? 0,
    cacheReadTokens: numberValue(record.cacheReadTokens) ?? 0,
    cacheWriteTokens: numberValue(record.cacheWriteTokens) ?? 0,
    totalTokens: numberValue(record.totalTokens) ?? 0,
    cost: numberValue(record.cost) ?? 0,
  };
}

function accumulateTotals(current: TelegramTotals, stats: Record<string, unknown>): TelegramTotals {
  return {
    loops: current.loops + 1,
    turnCount: current.turnCount + (numberValue(stats.turnCount) ?? 0),
    messageCount: current.messageCount + (numberValue(stats.messageCount) ?? 0),
    toolCount: current.toolCount + (numberValue(stats.toolCount) ?? 0),
    errorCount: current.errorCount + (numberValue(stats.errorCount) ?? 0),
    durationMs: current.durationMs + (numberValue(stats.durationMs) ?? 0),
    inputTokens: current.inputTokens + (numberValue(stats.inputTokens) ?? 0),
    outputTokens: current.outputTokens + (numberValue(stats.outputTokens) ?? 0),
    cacheReadTokens: current.cacheReadTokens + (numberValue(stats.cacheReadTokens) ?? 0),
    cacheWriteTokens: current.cacheWriteTokens + (numberValue(stats.cacheWriteTokens) ?? 0),
    totalTokens: current.totalTokens + (numberValue(stats.totalTokens) ?? 0),
    cost: current.cost + (numberValue(stats.cost) ?? 0),
  };
}

function findSplitPoint(text: string, separator: string): number {
  const splitAt = text.lastIndexOf(separator, MAX_MESSAGE_CHARS);
  return splitAt >= Math.floor(MAX_MESSAGE_CHARS * 0.5) ? splitAt + separator.length : -1;
}

function formatUsageLine(stats: Partial<TelegramTotals>): string | undefined {
  const parts: string[] = [];
  const totalTokens = stats.totalTokens;
  const inputTokens = stats.inputTokens;
  const outputTokens = stats.outputTokens;
  const cacheReadTokens = stats.cacheReadTokens;
  const cost = stats.cost;

  if (totalTokens !== undefined && totalTokens > 0) parts.push(`Tokens: ${totalTokens}`);
  if (inputTokens !== undefined && inputTokens > 0) {
    let input = `In: ${inputTokens}`;
    if (cacheReadTokens !== undefined && cacheReadTokens > 0) input += ` (cached ${cacheReadTokens})`;
    parts.push(input);
  }
  if (outputTokens !== undefined && outputTokens > 0) parts.push(`Out: ${outputTokens}`);
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

/** Parse a message_thread_id from the string --topic flag value. */
function parseThreadId(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return undefined;
  const num = Number(trimmed);
  return Number.isSafeInteger(num) && num > 0 ? num : undefined;
}

function isTopicEligibleChat(chatId: string): boolean {
  return chatId.trim().startsWith("-");
}

function dedupe(values: string[]): string[] {
  return Array.from(new Set(values));
}
