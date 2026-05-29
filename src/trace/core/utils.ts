export function oneLine(value: string, maxLength = 300): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 1))}…`;
}

export function contentToPreview(content: unknown, maxLength = 300): string {
  if (typeof content === "string") return oneLine(content, maxLength);
  if (!Array.isArray(content)) return oneLine(safeJson(content), maxLength);

  const text = content
    .map((block) => {
      if (!block || typeof block !== "object") return "";
      const b = block as Record<string, any>;
      if (b.type === "text") return b.text ?? "";
      if (b.type === "thinking") return `[thinking] ${b.thinking ?? ""}`;
      if (b.type === "toolCall") return `[toolCall:${b.name ?? "unknown"}]`;
      if (b.type === "image") return "[image]";
      return "";
    })
    .filter(Boolean)
    .join(" ");

  return oneLine(text || safeJson(content), maxLength);
}

export function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function extractMessageDelta(assistantMessageEvent: unknown):
  | { blockType: "thinking" | "text"; text: string }
  | undefined {
  if (!assistantMessageEvent || typeof assistantMessageEvent !== "object") return undefined;
  const event = assistantMessageEvent as Record<string, any>;
  if (event.type === "text_delta" && typeof event.delta === "string") {
    return { blockType: "text", text: event.delta };
  }
  if (event.type === "thinking_delta" && typeof event.delta === "string") {
    return { blockType: "thinking", text: event.delta };
  }
  return undefined;
}

export function messageRole(message: unknown): string {
  if (!message || typeof message !== "object") return "unknown";
  return String((message as Record<string, any>).role ?? "unknown");
}

export function messageContent(message: unknown): unknown {
  if (!message || typeof message !== "object") return undefined;
  return (message as Record<string, any>).content;
}

export function getModelFromMessages(messages: unknown): { provider?: string; model?: string } | undefined {
  if (!Array.isArray(messages)) return undefined;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i] as Record<string, any> | undefined;
    if (m?.role === "assistant") return { provider: m.provider, model: m.model };
  }
  return undefined;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  cost: number;
}

/** Aggregate token usage and cost across all assistant messages. */
export function getUsageFromMessages(messages: unknown): TokenUsage | undefined {
  if (!Array.isArray(messages)) return undefined;

  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let totalTokens = 0;
  let cost = 0;
  let found = false;

  for (const m of messages) {
    if (!m || typeof m !== "object") continue;
    const msg = m as Record<string, any>;
    if (msg.role !== "assistant" || !msg.usage) continue;
    found = true;
    const u = msg.usage;
    inputTokens += Number(u.input ?? 0);
    outputTokens += Number(u.output ?? 0);
    cacheReadTokens += Number(u.cacheRead ?? 0);
    cacheWriteTokens += Number(u.cacheWrite ?? 0);
    totalTokens += Number(u.totalTokens ?? 0);
    if (u.cost && typeof u.cost === "object") {
      cost += Number(u.cost.total ?? 0);
    }
  }

  return found ? { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, totalTokens, cost } : undefined;
}
