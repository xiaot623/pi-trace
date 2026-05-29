import { spawnSync } from "node:child_process";
import type { TraceConsumer, TraceEvent } from "../../core/types.js";
import { safeJson } from "../../core/utils.js";

export interface LarkTraceConsumerOptions {
  wikiSpaceId: string;
}

/** Max chars per single lark-cli --content call. */
const MAX_CHUNK_CHARS = 30000;
/** Max chars per single <pre><code> block; longer text is split into multiple blocks. */
const MAX_CODE_BLOCK_CHARS = 20000;

export class LarkTraceConsumer implements TraceConsumer {
  readonly name = "lark";
  readonly filter = { kinds: ["batch" as const] };

  private readonly wikiSpaceId: string;
  private documentToken?: string;
  private documentUrl?: string;

  // Metadata captured from the first event
  private runId = "unknown";
  private sessionName?: string;
  private sessionId?: string;
  private modelId?: string;
  private modelProvider?: string;
  private cwd?: string;
  private input?: string;
  private hasUserMessage = false;

  // Accumulated XML fragments for the current turn
  private pendingSections: string[] = [];
  private initialized = false;
  private flushSeq = 0;

  constructor(options: LarkTraceConsumerOptions) {
    this.wikiSpaceId = options.wikiSpaceId;
  }

  // --------------------------------------------------------------------------
  // TraceConsumer interface
  // --------------------------------------------------------------------------

  consume(event: TraceEvent): void | Promise<void> {
    this.ensureInitialized(event);

    switch (event.type) {
      case "message.record":
        this.handleMessageRecord(event.payload);
        break;
      case "tool.record":
        this.handleToolRecord(event.payload);
        break;
      case "turn.record":
        return this.handleTurnRecord(event.payload);
      case "agent.run":
        return this.handleAgentRun(event.payload);
    }
  }

  // --------------------------------------------------------------------------
  // Initialization (first event)
  // --------------------------------------------------------------------------

  private ensureInitialized(event: TraceEvent): void {
    if (this.initialized) return;
    this.initialized = true;

    const p = event.payload;
    this.runId = String(event.runId ?? p.runId ?? "unknown");
    this.sessionName = p.sessionName as string | undefined;
    this.sessionId = p.sessionId as string | undefined;
    this.modelId = p.modelId as string | undefined;
    this.modelProvider = p.modelProvider as string | undefined;
    this.cwd = p.cwd as string | undefined;
    this.input = typeof p.userInput === "string" ? p.userInput : undefined;
  }

  // --------------------------------------------------------------------------
  // Event handlers — accumulate into pendingSections
  // --------------------------------------------------------------------------

  private handleMessageRecord(payload: Record<string, unknown>): void {
    const role = String(payload.role ?? "unknown");
    const content = payload.content;

    // Skip toolResult messages (already captured by tool.record)
    if (role === "toolResult" || payload.toolCallId) return;

    if (role === "user") {
      this.hasUserMessage = true;
      this.pendingSections.push(`<h2>User</h2>`, contentToXml(content));
      return;
    }

    if (role === "assistant") {
      this.renderAssistantContent(content);
    }
  }

  private renderAssistantContent(content: unknown): void {
    if (!Array.isArray(content)) {
      this.pendingSections.push(`<h2>Assistant</h2>`, contentToXml(content));
      return;
    }

    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const item = block as Record<string, unknown>;
      if (item.type === "thinking") {
        const thinking = String(item.thinking ?? "").trim();
        if (thinking) {
          this.pendingSections.push(`<h2>Thinking</h2>`, contentToXml(thinking));
        }
      } else if (item.type === "text") {
        this.pendingSections.push(`<h2>Assistant</h2>`, contentToXml(String(item.text ?? "")));
      }
    }
  }

  private handleToolRecord(payload: Record<string, unknown>): void {
    const toolName = String(payload.toolName ?? "unknown");
    const status = payload.isError ? "error" : "success";

    this.pendingSections.push(`<h2>Tool Call: ${escapeXml(toolName)} (${status})</h2>`);
    this.pendingSections.push(xmlCodeBlock("json", safeJson(payload.input ?? null)));

    // Split long tool results into multiple code blocks instead of truncating
    const resultText = renderToolResultContent(payload.resultContent);
    for (const chunk of splitText(resultText, MAX_CODE_BLOCK_CHARS)) {
      this.pendingSections.push(xmlCodeBlock("text", chunk));
    }
  }

  // --------------------------------------------------------------------------
  // Flush triggers — render turn and write to Lark
  // --------------------------------------------------------------------------

  private async handleTurnRecord(payload: Record<string, unknown>): Promise<void> {
    await this.flush();
  }

  private async handleAgentRun(payload: Record<string, unknown>): Promise<void> {
    // If no user message was captured, add input from run payload
    if (!this.hasUserMessage && typeof payload.userInput === "string" && (payload.userInput as string).trim()) {
      this.pendingSections.push(`<h2>User</h2>`, contentToXml(payload.userInput as string));
    }
    this.pendingSections.push(`<h1>Summary</h1>`);
    this.pendingSections.push(xmlCodeBlock("json", safeJson(payload.stats ?? {})));
    await this.flush();
  }

  // --------------------------------------------------------------------------
  // Flush — build XML and call lark-cli
  // --------------------------------------------------------------------------

  private async flush(): Promise<void> {
    if (this.pendingSections.length === 0) return;

    this.flushSeq += 1;
    const seq = this.flushSeq;
    const sections = [...this.pendingSections];
    this.pendingSections = [];

    try {
      if (!this.documentToken) {
        // First flush: create wiki node, then append content
        const title = this.deriveTitle();
        const nodeResult = this.execLarkCli([
          "wiki", "+node-create",
          "--space-id", this.wikiSpaceId,
          "--title", title,
          "--obj-type", "docx",
        ], "");
        this.extractDocumentToken(nodeResult);

        // Append callout + initial content
        const createXml = this.buildCreateXml([]);
        this.execLarkCli([
          "docs", "+update",
          "--api-version", "v2",
          "--doc", this.documentToken!,
          "--command", "append",
          "--content", "-",
        ], createXml);
      }

      // Append turn content in chunks — never truncate
      this.appendInChunks(sections);
      console.error(`[trace:lark] flush #${seq} ok${this.documentUrl ? ` → ${this.documentUrl}` : ""}`);
    } catch (error) {
      console.error(`[trace:lark] flush #${seq} failed`, error);
    }
  }

  /** Append sections to the document, splitting into multiple CLI calls if needed. */
  private appendInChunks(sections: string[]): void {
    const chunks = packSectionsIntoChunks(sections, MAX_CHUNK_CHARS);

    for (let i = 0; i < chunks.length; i++) {
      this.execLarkCli([
        "docs", "+update",
        "--api-version", "v2",
        "--doc", this.documentToken!,
        "--command", "append",
        "--content", "-",
      ], chunks[i]);

      if (chunks.length > 1) {
        console.error(`[trace:lark] appended chunk ${i + 1}/${chunks.length}`);
      }
    }
  }

  private buildCreateXml(turnSections: string[]): string {
    const callout = this.buildCalloutXml();
    return [callout, ...turnSections].join("\n");
  }

  // --------------------------------------------------------------------------
  // Title derivation (same logic as markdown consumer filename)
  // --------------------------------------------------------------------------

  private deriveTitle(): string {
    if (this.sessionName?.trim()) {
      return `Pi Trace — ${this.sessionName.trim()}`;
    }
    if (this.input?.trim()) {
      const firstLine = this.input.trim().split("\n")[0].trim().slice(0, 100);
      return `Pi Trace — ${firstLine}`;
    }
    if (this.sessionId) {
      return `Pi Trace — ${this.sessionId}`;
    }
    return "Pi Trace";
  }

  // --------------------------------------------------------------------------
  // Callout block for metadata
  // --------------------------------------------------------------------------

  private buildCalloutXml(): string {
    const lines: string[] = [];
    lines.push(`<callout emoji="📊" background-color="light-blue">`);
    lines.push(`<p><b>Run ID:</b> <code>${escapeXml(this.runId)}</code></p>`);
    if (this.sessionName) {
      lines.push(`<p><b>Session Name:</b> <code>${escapeXml(this.sessionName)}</code></p>`);
    }
    if (this.sessionId) {
      lines.push(`<p><b>Session ID:</b> <code>${escapeXml(this.sessionId)}</code></p>`);
    }
    if (this.modelId) {
      const rawModel = this.modelProvider ? `${this.modelProvider}/${this.modelId}` : this.modelId;
      lines.push(`<p><b>Model:</b> <code>${escapeXml(rawModel)}</code></p>`);
    }
    if (this.cwd) {
      lines.push(`<p><b>Workspace:</b> <code>${escapeXml(this.cwd)}</code></p>`);
    }
    lines.push(`</callout>`);
    return lines.join("\n");
  }

  // --------------------------------------------------------------------------
  // Lark CLI execution
  // --------------------------------------------------------------------------

  private execLarkCli(args: string[], stdinContent: string): string {
    const result = spawnSync("lark-cli", args, {
      input: stdinContent,
      encoding: "utf8",
      timeout: 30_000,
    });

    if (result.error) {
      throw new Error(`lark-cli spawn failed: ${result.error.message}`);
    }

    const stdout = result.stdout ?? "";
    const stderr = result.stderr ?? "";

    if (result.status !== 0) {
      throw new Error(`lark-cli exited with ${result.status}: ${stderr || stdout}`);
    }

    return stdout;
  }

  private extractDocumentToken(stdout: string): void {
    try {
      const json = JSON.parse(stdout) as Record<string, any>;
      // wiki +node-create response format
      const objToken = json?.data?.obj_token;
      const url = json?.data?.url;
      if (objToken) {
        this.documentToken = String(objToken);
        this.documentUrl = url;
        console.error(`[trace:lark] created wiki node ${this.documentToken}`);
        return;
      }
      // docs +create response format (legacy)
      const docId = json?.data?.document?.document_id;
      if (docId) {
        this.documentToken = String(docId);
        this.documentUrl = json?.data?.document?.url;
        console.error(`[trace:lark] created document ${this.documentToken}`);
      } else {
        console.error(`[trace:lark] no obj_token or document_id in response:`, stdout.slice(0, 200));
      }
    } catch {
      console.error(`[trace:lark] failed to parse create response:`, stdout.slice(0, 200));
    }
  }
}

// ============================================================================
// XML utility functions
// ============================================================================

/** Escape text for safe embedding inside Lark XML. */
function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\n/g, "<br/>");
}

/** Wrap text in a <pre><code> block. */
function xmlCodeBlock(language: string, value: string): string {
  const escaped = escapeXml(value);
  return `<pre lang="${language}"><code>${escaped}</code></pre>`;
}

/** Convert message content (string or block array) to XML paragraphs. */
function contentToXml(content: unknown): string {
  if (typeof content === "string") {
    return `<p>${escapeXml(content)}</p>`;
  }
  if (!Array.isArray(content)) {
    return `<p>${escapeXml(safeJson(content))}</p>`;
  }

  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const item = block as Record<string, unknown>;
    if (item.type === "text") {
      const text = String(item.text ?? "");
      if (text.trim()) parts.push(`<p>${escapeXml(text)}</p>`);
    } else if (item.type === "image") {
      parts.push(`<p>[image]</p>`);
    }
    // thinking blocks are handled separately in renderAssistantContent
  }

  return parts.join("\n") || `<p>(empty)</p>`;
}

/** Render tool result content to plain text. */
function renderToolResultContent(content: unknown): string {
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

/** Split text into chunks, preferring line boundaries. */
function splitText(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) return [text];

  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxChars) {
      chunks.push(remaining);
      break;
    }
    // Try to split at a newline near the limit
    let splitAt = remaining.lastIndexOf("\n", maxChars);
    if (splitAt < maxChars * 0.5) splitAt = maxChars;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).replace(/^\n/, "");
  }
  return chunks;
}

/** Pack sections into chunks that each fit within maxChars. */
function packSectionsIntoChunks(sections: string[], maxChars: number): string[] {
  const chunks: string[] = [];
  let current = "";

  for (const section of sections) {
    const addition = current ? `\n${section}` : section;

    if (current.length + addition.length <= maxChars) {
      current += addition;
    } else {
      if (current) chunks.push(current);

      // If a single section exceeds the limit, split it into sub-chunks
      if (section.length > maxChars) {
        const parts = splitText(section, maxChars);
        for (let i = 0; i < parts.length - 1; i++) {
          chunks.push(parts[i]);
        }
        current = parts[parts.length - 1];
      } else {
        current = section;
      }
    }
  }

  if (current) chunks.push(current);
  return chunks;
}
