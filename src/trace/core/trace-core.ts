import type { TraceConsumer, TraceConsumerFilter, TraceEvent, TraceKind } from "./types.js";

export function matchesTraceFilter(kind: TraceKind, filter?: TraceConsumerFilter): boolean {
  if (!filter?.kinds || filter.kinds.length === 0) return true;
  return filter.kinds.includes("both") || filter.kinds.includes(kind);
}

export class TraceCore {
  private readonly consumers: TraceConsumer[] = [];

  registerConsumer(consumer: TraceConsumer): void {
    this.consumers.push(consumer);
  }

  publish(event: TraceEvent): void {
    for (const consumer of this.consumers) {
      if (!matchesTraceFilter(event.kind, consumer.filter)) continue;
      try {
        void Promise.resolve(consumer.consume(event)).catch((error: unknown) => {
          // Consumers must not break pi's hook chain.
          console.error(`[trace] consumer ${consumer.name} failed`, error);
        });
      } catch (error) {
        // Consumers must not break pi's hook chain.
        console.error(`[trace] consumer ${consumer.name} failed`, error);
      }
    }
  }
}
