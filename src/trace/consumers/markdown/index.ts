import { dirname } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import type { TraceConsumer, TraceEvent } from "../../core/types.js";
import { safeJson } from "../../core/utils.js";

export interface MarkdownTraceConsumerOptions {
  outputPath: string;
}

export class MarkdownTraceConsumer implements TraceConsumer {
  readonly name = "markdown";
  readonly filter = { kinds: ["batch" as const] };

  private readonly outputPath: string;
  private readonly sections: string[] = [];
  private initialized = false;
  private hasUser = false;

  constructor(options: MarkdownTraceConsumerOptions) {
    this.outputPath = options.outputPath;
  }

  consume(event: TraceEvent): void {
    this.ensureInitialized(event);

    switch (event.type) {
      case "message.record":
        this.renderMessage(event.payload);
        break;
      case "tool.record":
        this.renderToolCall(event.payload);
        break;
      case "turn.record":
        this.renderTurn(event.payload);
        break;
      case "agent.run":
        this.renderSummary(event.payload);
        break;
    }

    this.flush();
  }

  private ensureInitialized(event: TraceEvent): void {
    if (this.initialized) return;
    this.initialized = true;
    this.sections.push("# Pi Trace", "", `Run ID: \`${event.runId ?? "unknown"}\``, "");
  }

  private renderMessage(payload: Record<string, unknown>): void {
    const role = String(payload.role ?? "unknown");
    const content = payload.content;

    if (role === "user") {
      this.hasUser = true;
      this.sections.push("## User", "", renderContentAsMarkdown(content), "");
      return;
    }

    if (role === "assistant") {
      this.renderAssistantContent(content);
      return;
    }
  }

  private renderAssistantContent(content: unknown): void {
    if (!Array.isArray(content)) {
      this.sections.push("## Assistant", "", renderContentAsMarkdown(content), "");
      return;
    }

    const thinkingBlocks = content.filter(isThinkingBlock);
    if (thinkingBlocks.length === 0) {
      this.sections.push("## Thinking", "", "_Not captured._", "");
    }

    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const item = block as Record<string, unknown>;
      if (item.type === "thinking") {
        this.sections.push("## Thinking", "", String(item.thinking ?? ""), "");
      } else if (item.type === "text") {
        this.sections.push("## Assistant", "", String(item.text ?? ""), "");
      } else if (item.type === "toolCall") {
        this.sections.push(
          "## Tool Call",
          "",
          `Tool: \`${String(item.name ?? "unknown")}\``,
          "",
          "```json",
          safeJson(item.arguments ?? {}),
          "```",
          "",
        );
      }
    }
  }

  private renderToolCall(payload: Record<string, unknown>): void {
    this.sections.push(
      "## Tool Call",
      "",
      `Tool: \`${String(payload.toolName ?? "unknown")}\``,
      "",
      `Tool Call ID: \`${String(payload.toolCallId ?? "unknown")}\``,
      "",
      "### Input",
      "",
      "```json",
      safeJson(payload.input ?? null),
      "```",
      "",
      "### Result",
      "",
      renderContentAsMarkdown(payload.resultContent),
      "",
    );
  }

  private renderTurn(payload: Record<string, unknown>): void {
    this.sections.push(
      "## Turn",
      "",
      `Turn index: \`${String(payload.turnIndex ?? "unknown")}\``,
      "",
      `Duration: \`${String(payload.durationMs ?? 0)}ms\``,
      "",
    );
  }

  private renderSummary(payload: Record<string, unknown>): void {
    if (!this.hasUser && typeof payload.input === "string" && payload.input.trim()) {
      this.hasUser = true;
      this.sections.push("## User", "", payload.input, "");
    }
    this.sections.push("## Summary", "", "```json", safeJson(payload.stats ?? {}), "```", "");
  }

  private flush(): void {
    mkdirSync(dirname(this.outputPath), { recursive: true });
    writeFileSync(this.outputPath, `${this.sections.join("\n").trimEnd()}\n`, "utf8");
  }
}

function isThinkingBlock(block: unknown): boolean {
  return Boolean(block && typeof block === "object" && (block as Record<string, unknown>).type === "thinking");
}

function renderContentAsMarkdown(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return fencedJson(content);

  const parts = content.map((block) => {
    if (!block || typeof block !== "object") return "";
    const item = block as Record<string, unknown>;
    if (item.type === "text") return String(item.text ?? "");
    if (item.type === "thinking") return String(item.thinking ?? "");
    if (item.type === "image") return "[image]";
    return fencedJson(item);
  });

  return parts.filter(Boolean).join("\n\n");
}

function fencedJson(value: unknown): string {
  return ["```json", safeJson(value), "```"].join("\n");
}
