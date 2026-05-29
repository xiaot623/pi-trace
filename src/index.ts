import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolveTraceConsumerConfig } from "./trace/config/consumer-config.js";
import { ConsoleTraceConsumer } from "./trace/consumers/console/index.js";
import { MarkdownTraceConsumer } from "./trace/consumers/markdown/index.js";
import { TraceCore } from "./trace/core/trace-core.js";
import { TraceProducer } from "./trace/producers/pi-hook-producer.js";
import type { TraceFilterKind } from "./trace/core/types.js";

export { resolveTraceConsumerConfig } from "./trace/config/consumer-config.js";
export type { ConsoleConsumerConfig, MarkdownConsumerConfig, TraceConsumerConfig, TraceConsumerConfigInput, TraceRuntimeMode } from "./trace/config/consumer-config.js";
export { ConsoleTraceConsumer } from "./trace/consumers/console/index.js";
export { MarkdownTraceConsumer } from "./trace/consumers/markdown/index.js";
export { TraceCore, matchesTraceFilter } from "./trace/core/trace-core.js";
export { TraceProducer } from "./trace/producers/pi-hook-producer.js";
export type { TraceConsumer, TraceConsumerFilter, TraceEvent, TraceFilterKind, TraceKind } from "./trace/core/types.js";

export default function traceExtension(pi: ExtensionAPI): void {
  const config = resolveTraceConsumerConfig();
  const core = new TraceCore();

  if (config.console.enabled) {
    core.registerConsumer(new ConsoleTraceConsumer({ filter: readFilterFromEnv() }));
  }

  if (config.markdown.enabled) {
    core.registerConsumer(new MarkdownTraceConsumer({ outputPath: config.markdown.outputPath }));
  }

  const producer = new TraceProducer(core);
  producer.register(pi);
}

function readFilterFromEnv(): { kinds?: TraceFilterKind[] } | undefined {
  const raw = readEnv("PI_TRACE_KINDS");
  if (!raw) return undefined;

  const kinds = raw
    .split(",")
    .map((part) => part.trim().toLowerCase())
    .filter((part): part is TraceFilterKind => part === "realtime" || part === "batch" || part === "both");

  return kinds.length > 0 ? { kinds } : undefined;
}

function readEnv(name: string): string | undefined {
  return (globalThis as any).process?.env?.[name] as string | undefined;
}
