import type { TraceConsumer, TraceConsumerFilter, TraceEvent } from "../../core/types.js";
import { contentToPreview, oneLine } from "../../core/utils.js";
import { logger } from "../../core/logger.js";

export interface ConsoleTraceConsumerOptions {
  filter?: TraceConsumerFilter;
}

export class ConsoleTraceConsumer implements TraceConsumer {
  readonly name = "console";
  readonly filter?: TraceConsumerFilter;

  constructor(options: ConsoleTraceConsumerOptions = {}) {
    this.filter = options.filter;
  }

  consume(event: TraceEvent): void {
    logger.info(this.format(event));
  }

  private format(event: TraceEvent): string {
    const p = event.payload as Record<string, any>;
    const base = `[trace ${event.kind}] ${event.type}`;

    switch (event.type) {
      case "turn.started":
      case "turn.ended":
      case "turn.record":
        return `${base} turn=${p.turnIndex}`;
      case "message.started":
      case "message.ended":
        return `${base} role=${p.role}`;
      case "message.delta":
        return `${base} ${p.blockType} ${JSON.stringify(oneLine(String(p.text ?? ""), 120))}`;
      case "message.record":
        return `${base} role=${p.role} ${JSON.stringify(contentToPreview(p.content, 160))}`;
      case "tool.started":
      case "tool.ended":
        return `${base} ${p.toolName} id=${p.toolCallId}`;
      case "tool.result":
        return `${base} ${p.toolName} error=${Boolean(p.isError)} ${JSON.stringify(p.contentPreview ?? "")}`;
      case "tool.record":
        return `${base} ${p.toolName} id=${p.toolCallId} durationMs=${p.durationMs ?? 0}`;
      case "agent.run":
        return `${base} run=${event.runId ?? ""} events=${Array.isArray(p.eventIds) ? p.eventIds.length : 0}`;
      default:
        return base;
    }
  }
}
