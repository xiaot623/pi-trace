import test from "node:test";
import assert from "node:assert/strict";
import { defaultTimeoutMs, formatFailure, multiTurnToolPrompts, runPiTraceE2E } from "./helpers/pi-runner.mjs";
import { assetMapPath, cleanupArtifacts, combineOutput, enableAllConsumers, markdownDir } from "./helpers/setup.mjs";
import { assertConsoleBatchEvents, assertConsoleMultiTurnBatchEvents, assertConsoleRealtimeEvents } from "./consumers/console/assertions.mjs";
import { assertMarkdownCreated, assertMultiTurnMarkdown, assertSingleTurnMarkdown, findMarkdownFiles } from "./consumers/markdown/assertions.mjs";
import { assertLarkAssetMap, assertLarkFlushOk, assertLarkNodeCreated } from "./consumers/lark/assertions.mjs";

test(
  "config with enabled consumers runs all consumers in one real pi run",
  { timeout: defaultTimeoutMs + 10_000 },
  async () => {
    cleanupArtifacts();
    enableAllConsumers();

    const result = await runPiTraceE2E();
    assert.equal(result.code, 0, formatFailure(result));

    const output = combineOutput(result);
    assert.match(output, /trace-ok/, output);

    // Console consumer
    assertConsoleRealtimeEvents(output);
    assertConsoleBatchEvents(output);

    // Markdown consumer
    const markdownFiles = assertMarkdownCreated(markdownDir);
    assertSingleTurnMarkdown(markdownFiles);

    // Lark consumer
    assertLarkNodeCreated(output);
    assertLarkFlushOk(output);
  },
);

test(
  "config with enabled consumers records a real multi-turn pi run",
  { timeout: defaultTimeoutMs + 30_000 },
  async () => {
    cleanupArtifacts();
    enableAllConsumers();

    const result = await runPiTraceE2E({ prompts: multiTurnToolPrompts });
    assert.equal(result.code, 0, formatFailure(result));

    const output = combineOutput(result);
    assert.match(output, /trace-turn-0/, output);
    assert.match(output, /trace-turn-1/, output);

    // Console consumer
    assertConsoleMultiTurnBatchEvents(output);

    // Markdown consumer
    const markdownFiles = assertMarkdownCreated(markdownDir);
    assertMultiTurnMarkdown(markdownFiles);

    // Lark consumer — asset map 含 documentToken 且 markdown 路径关联正确
    assertLarkAssetMap(assetMapPath, markdownFiles);
  },
);
