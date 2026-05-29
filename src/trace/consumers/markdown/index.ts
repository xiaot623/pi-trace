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
      }
    }
  }

  private renderToolCall(payload: Record<string, unknown>): void {
    const toolName = String(payload.toolName ?? "unknown");
    const status = payload.isError ? "error" : "success";

    this.sections.push(
      `## Tool Call: ${toolName} (${status})`,
      "",
      fencedCode("json", safeJson(payload.input ?? null)),
      "",
      fencedCode("text", renderContentAsPlainText(payload.resultContent)),
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

function renderContentAsPlainText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return safeJson(content);

  const parts = content.map((block) => {
    if (!block || typeof block !== "object") return "";
    const item = block as Record<string, unknown>;
    if (item.type === "text") return String(item.text ?? "");
    if (item.type === "thinking") return String(item.thinking ?? "");
    if (item.type === "image") return "[image]";
    return safeJson(item);
  });

  return parts.filter(Boolean).join("\n\n");
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
  return fencedCode("json", safeJson(value));
}

function fencedCode(language: string, value: string): string {
  const longestBacktickRun = Math.max(0, ...Array.from(value.matchAll(/`+/g), (match) => match[0].length));
  const fence = "`".repeat(Math.max(3, longestBacktickRun + 1));
  return [`${fence}${language}`, value, fence].join("\n");
}
