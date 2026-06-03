import test from "node:test";
import assert from "node:assert/strict";
import { defaultTimeoutMs, formatFailure, multiTurnToolPrompts, runPiTraceE2E } from "./helpers/pi-runner.mjs";
import { assetMapPath, cleanupArtifacts, combineOutput, configPath, isConsumerEnabled, markdownDir, readConfig } from "./helpers/setup.mjs";
import { assertConsoleBatchEvents, assertConsoleMultiTurnBatchEvents, assertConsoleRealtimeEvents } from "./consumers/console/assertions.mjs";
import { assertMarkdownCreated, assertMultiTurnMarkdown, assertSingleTurnMarkdown } from "./consumers/markdown/assertions.mjs";
import { assertLarkAssetMap, assertLarkFlushOk, assertLarkNodeCreated } from "./consumers/lark/assertions.mjs";
import { assertTelegramActive, assertTelegramAssetMap } from "./consumers/telegram/assertions.mjs";

const config = readConfig();

test(
  "config with enabled consumers runs all consumers in one real pi run",
  { timeout: defaultTimeoutMs + 10_000 },
  async () => {
    cleanupArtifacts();

    const result = await runPiTraceE2E();
    assert.equal(result.code, 0, formatFailure(result));

    const output = combineOutput(result);
    assert.match(output, /trace-ok/, output);

    // Console consumer
    if (isConsumerEnabled(config, "console")) {
      assertConsoleRealtimeEvents(output);
      assertConsoleBatchEvents(output);
    }

    // Markdown consumer
    if (isConsumerEnabled(config, "markdown")) {
      const markdownFiles = assertMarkdownCreated(markdownDir);
      assertSingleTurnMarkdown(markdownFiles);
    }

    // Lark consumer
    if (isConsumerEnabled(config, "lark")) {
      assertLarkNodeCreated(output);
      assertLarkFlushOk(output);
    }

    // Telegram consumer
    if (isConsumerEnabled(config, "telegram")) {
      assertTelegramActive(output);
      assertTelegramAssetMap(assetMapPath);
    }
  },
);

test(
  "config with enabled consumers records a real multi-turn pi run",
  { timeout: defaultTimeoutMs + 30_000 },
  async () => {
    cleanupArtifacts();

    const result = await runPiTraceE2E({ prompts: multiTurnToolPrompts });
    assert.equal(result.code, 0, formatFailure(result));

    const output = combineOutput(result);
    assert.match(output, /trace-turn-0/, output);
    assert.match(output, /trace-turn-1/, output);

    // Console consumer
    if (isConsumerEnabled(config, "console")) {
      assertConsoleMultiTurnBatchEvents(output);
    }

    // Markdown consumer
    if (isConsumerEnabled(config, "markdown")) {
      const markdownFiles = assertMarkdownCreated(markdownDir);
      assertMultiTurnMarkdown(markdownFiles);

      // Lark consumer — asset map 含 documentToken 且 markdown 路径关联正确
      if (isConsumerEnabled(config, "lark")) {
        assertLarkAssetMap(assetMapPath, markdownFiles);
      }
    }

    // Telegram consumer
    if (isConsumerEnabled(config, "telegram")) {
      assertTelegramActive(output);
    }
  },
);
