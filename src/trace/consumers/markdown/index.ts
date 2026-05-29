import { join } from "node:path";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { updateSessionAssetMap } from "../../assets/session-asset-map.js";
import type { TraceConsumer, TraceEvent } from "../../core/types.js";
import { safeJson } from "../../core/utils.js";
import { buildTraceTitle, deriveTraceTitleSubject, formatTraceMonth, sanitizeTraceFileName } from "../title.js";

export interface MarkdownTraceConsumerOptions {
  outputDir: string;
  assetMapPath?: string;
}

export class MarkdownTraceConsumer implements TraceConsumer {
  readonly name = "markdown";
  readonly filter = { kinds: ["batch" as const] };

  private readonly outputDir: string;
  private readonly assetMapPath?: string;
  private currentOutputDir: string;
  private outputPath: string;
  private readonly sections: string[] = [];
  private initialized = false;
  private hasUser = false;
  private outputPathFinalized = false;
  private sessionId: string | undefined;
  private timestamp = Date.now();

  constructor(options: MarkdownTraceConsumerOptions) {
    const now = Date.now();
    this.outputDir = options.outputDir;
    this.currentOutputDir = join(options.outputDir, formatTraceMonth(now));
    this.assetMapPath = options.assetMapPath;
    const title = buildTraceTitle(now);
    this.outputPath = join(this.currentOutputDir, `${sanitizeTraceFileName(title)}.md`);
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

    const sessionId = event.payload.sessionId as string | undefined;
    this.sessionId = sessionId;
    this.timestamp = event.timestamp;
    this.currentOutputDir = join(this.outputDir, formatTraceMonth(event.timestamp));
    const titleSubject = deriveTraceTitleSubject(event.payload);
    const title = buildTraceTitle(event.timestamp, titleSubject);
    this.outputPath = join(this.currentOutputDir, `${sanitizeTraceFileName(title)}.md`);
    const sessionName = event.payload.sessionName as string | undefined;
    const modelId = event.payload.modelId as string | undefined;
    const modelProvider = event.payload.modelProvider as string | undefined;
    const cwd = event.payload.cwd as string | undefined;
    this.outputPathFinalized = Boolean(titleSubject);
    updateSessionAssetMap(this.assetMapPath, sessionId, {
      markdown: { path: this.outputPath },
    });

    this.sections.push(`# ${title}`, "");

    const metaLines: string[] = [];
    metaLines.push(`> **Run ID:** \`${event.runId ?? "unknown"}\``);
    if (sessionName) {
      metaLines.push(`> **Session Name:** \`${sessionName}\``);
    }
    if (sessionId) {
      metaLines.push(`> **Session ID:** \`${sessionId}\``);
    }
    if (modelId) {
      const rawModel = modelProvider ? `${modelProvider}/${modelId}` : modelId;
      metaLines.push(`> **Model:** \`${rawModel}\``);
    }
    if (cwd) {
      metaLines.push(`> **Workspace:** \`${cwd}\``);
    }

    this.sections.push(...metaLines, "");
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

    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const item = block as Record<string, unknown>;
      if (item.type === "thinking") {
        const thinking = String(item.thinking ?? "").trim();
        if (thinking) {
          this.sections.push("## Thinking", "", thinking, "");
        }
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
    const input = typeof payload.input === "string" ? payload.input : undefined;

    // If we never locked a meaningful filename, try to derive one from input now.
    if (!this.outputPathFinalized) {
      const titleSubject = deriveTraceTitleSubject(payload);
      if (titleSubject) {
        const title = buildTraceTitle(this.timestamp, titleSubject);
        const oldPath = this.outputPath;
        const newPath = join(this.currentOutputDir, `${sanitizeTraceFileName(title)}.md`);
        this.sections[0] = `# ${title}`;
        if (newPath !== oldPath) {
          try { renameSync(oldPath, newPath); } catch { /* file may not exist yet */ }
          this.outputPath = newPath;
          updateSessionAssetMap(this.assetMapPath, this.sessionId, {
            markdown: { path: this.outputPath },
          });
        }
        this.outputPathFinalized = true;
      }
    }

    if (!this.hasUser && input && input.trim()) {
      this.hasUser = true;
      this.sections.push("## User", "", input, "");
    }
    this.sections.push("## Summary", "", "```json", safeJson(payload.stats ?? {}), "```", "");
  }

  private flush(): void {
    mkdirSync(this.currentOutputDir, { recursive: true });
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
