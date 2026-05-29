import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ConsoleTraceConsumer } from "./trace/consumers/console/index.js";
import { TraceCore } from "./trace/core/trace-core.js";
import { TraceProducer } from "./trace/producers/pi-hook-producer.js";
import type { TraceFilterKind } from "./trace/core/types.js";

export { ConsoleTraceConsumer } from "./trace/consumers/console/index.js";
export { TraceCore, matchesTraceFilter } from "./trace/core/trace-core.js";
export { TraceProducer } from "./trace/producers/pi-hook-producer.js";
export type { TraceConsumer, TraceConsumerFilter, TraceEvent, TraceFilterKind, TraceKind } from "./trace/core/types.js";

export default function traceExtension(pi: ExtensionAPI): void {
  const core = new TraceCore();
  core.registerConsumer(new ConsoleTraceConsumer({ filter: readFilterFromEnv() }));

  const producer = new TraceProducer(core);
  producer.register(pi);
}

function readFilterFromEnv(): { kinds?: TraceFilterKind[] } | undefined {
  const raw = (globalThis as any).process?.env?.PI_TRACE_KINDS as string | undefined;
  if (!raw) return undefined;

  const kinds = raw
    .split(",")
    .map((part) => part.trim().toLowerCase())
    .filter((part): part is TraceFilterKind => part === "realtime" || part === "batch" || part === "both");

  return kinds.length > 0 ? { kinds } : undefined;
}
