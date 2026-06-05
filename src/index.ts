import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { resolveConfig } from "./trace/config/resolve-config.js";
import { ConsoleTraceConsumer } from "./trace/consumers/console/index.js";
import { MarkdownTraceConsumer } from "./trace/consumers/markdown/index.js";
import { LarkTraceConsumer } from "./trace/consumers/lark/index.js";
import { TelegramTraceConsumer } from "./trace/consumers/telegram/index.js";
import { TraceCore } from "./trace/core/trace-core.js";
import { TraceProducer } from "./trace/producers/pi-hook-producer.js";
import { logger } from "./trace/core/logger.js";
import { registerFlags } from "./trace/flags.js";
export { resolveConfig } from "./trace/config/resolve-config.js";
export type {
  ConsoleConfig,
  ConsoleUserConfig,
  LarkConfig,
  LarkUserConfig,
  MarkdownConfig,
  MarkdownUserConfig,
  TelegramConfig,
  TelegramUserConfig,
  TraceConfig,
  TraceUserConfig,
  ResolveConfigOptions,
} from "./trace/config/types.js";
export { ConsoleTraceConsumer } from "./trace/consumers/console/index.js";
export { MarkdownTraceConsumer } from "./trace/consumers/markdown/index.js";
export { LarkTraceConsumer } from "./trace/consumers/lark/index.js";
export { TelegramTraceConsumer } from "./trace/consumers/telegram/index.js";
export { TraceCore, matchesTraceFilter } from "./trace/core/trace-core.js";
export { TraceProducer } from "./trace/producers/pi-hook-producer.js";
export type { TraceConsumer, TraceConsumerFilter, TraceEvent, TraceFilterKind, TraceKind } from "./trace/core/types.js";

export default function traceExtension(pi: ExtensionAPI): void {
  registerFlags(pi);

  const config = resolveConfig();
  logger.init(config.logDir);
  const core = new TraceCore();

  if (config.console.enabled) {
    core.registerConsumer(new ConsoleTraceConsumer({ filter: config.console.filter }));
  }

  if (config.markdown.enabled) {
    core.registerConsumer(new MarkdownTraceConsumer({
      outputDir: join(config.assetDir, "markdown"),
      assetMapPath: config.assetMapPath,
    }));
  }

  if (config.lark.enabled) {
    core.registerConsumer(new LarkTraceConsumer({
      wikiSpaceId: config.lark.wiki_space_id,
      assetMapPath: config.assetMapPath,
    }));
  }

  if (config.telegram.enabled) {
    core.registerConsumer(new TelegramTraceConsumer({
      botToken: config.telegram.botToken,
      chatIds: config.telegram.chatIds,
      assetMapPath: config.assetMapPath,
    }));
  }

  const producer = new TraceProducer(core);
  producer.register(pi);
}
