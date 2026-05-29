import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defaultTimeoutMs, formatFailure, multiTurnToolPrompts, repoRoot, runPiTraceE2E } from "./helpers/pi-runner.mjs";

const assetDir = join(repoRoot, "dev_assets");
const markdownDir = join(repoRoot, "dev_assets", "markdown");
const configPath = join(repoRoot, "dev_assets", "pi-trace.config.json");
const assetMapPath = join(repoRoot, "dev_assets", "pi-trace.assets.json");

function enableAllConsumers() {
  mkdirSync(assetDir, { recursive: true });
  writeFileSync(
    configPath,
    JSON.stringify(
      {
        consumers: {
          console: { enabled: true, filter: { kinds: ["both"] } },
          markdown: { enabled: true },
          lark: { enabled: true, wiki_space_id: "process.env.WIKI_SPACE_ID || """ },
        },
      },
      null,
      2
    ) + "\n",
    "utf8"
  );
}

test(
  "config with enabled consumers runs all consumers in one real pi run",
  { timeout: defaultTimeoutMs + 10_000 },
  async () => {
    rmSync(markdownDir, { recursive: true, force: true });
    rmSync(assetMapPath, { force: true });

    enableAllConsumers();

    const result = await runPiTraceE2E();
    assert.equal(result.code, 0, formatFailure(result));

    const output = `${result.stdout}\n${result.stderr}`;
    assert.match(output, /\[trace realtime\] turn\.started/, output);
    assert.match(output, /\[trace realtime\] message\.started role=assistant/, output);
    assert.match(output, /\[trace realtime\] tool\.started bash/, output);
    assert.match(output, /\[trace realtime\] tool\.result bash/, output);
    assert.match(output, /\[trace realtime\] tool\.ended bash/, output);
    assert.match(output, /\[trace batch\] message\.record role=assistant/, output);
    assert.match(output, /\[trace batch\] tool\.record bash/, output);
    assert.match(output, /\[trace batch\] turn\.record turn=0/, output);
    assert.match(output, /\[trace batch\] agent\.run/, output);
    assert.match(output, /trace-ok/, output);

    assert.equal(existsSync(markdownDir), true, `missing markdown dir: ${markdownDir}`);
    const markdownFiles = findMarkdownFiles(markdownDir);
    assert.equal(markdownFiles.length, 1, `expected one markdown file under ${markdownDir}, got ${markdownFiles.join(", ")}`);

    const markdown = readFileSync(markdownFiles[0], "utf8");
    assert.match(markdown, /^# Pi Trace/m, markdown);
    assert.match(markdown, /^## User/m, markdown);
    assert.match(markdown, /^## Assistant/m, markdown);
    assert.match(markdown, /^## Tool Call: bash \(success\)$/m, markdown);
    assert.match(markdown, /```json\n[\s\S]*echo trace-ok[\s\S]*\n```/, markdown);
    assert.match(markdown, /```text\n[\s\S]*trace-ok[\s\S]*\n```/, markdown);
    assert.match(markdown, /^## Summary/m, markdown);

    // Verify lark consumer created a document
    assert.match(output, /\[trace:lark\] created wiki node/, "lark consumer should create wiki node");
    assert.match(output, /\[trace:lark\] flush #\d+ ok/, "lark consumer should flush successfully");
  },
);

test(
  "config with enabled consumers records a real multi-turn pi run",
  { timeout: defaultTimeoutMs + 30_000 },
  async () => {
    rmSync(markdownDir, { recursive: true, force: true });
    rmSync(assetMapPath, { force: true });

    enableAllConsumers();

    const result = await runPiTraceE2E({ prompts: multiTurnToolPrompts });
    assert.equal(result.code, 0, formatFailure(result));

    const output = `${result.stdout}\n${result.stderr}`;
    assert.match(output, /\[trace batch\] turn\.record turn=0/, output);
    assert.match(output, /\[trace batch\] turn\.record turn=1/, output);
    assert.match(output, /trace-turn-0/, output);
    assert.match(output, /trace-turn-1/, output);

    assert.equal(existsSync(markdownDir), true, `missing markdown dir: ${markdownDir}`);
    const markdownFiles = findMarkdownFiles(markdownDir);
    assert.equal(markdownFiles.length, 1, `expected one markdown file under ${markdownDir}, got ${markdownFiles.join(", ")}`);

    const markdownPath = markdownFiles[0];
    const markdown = readFileSync(markdownPath, "utf8");
    assert.match(markdown, /trace-turn-0/, markdown);
    assert.match(markdown, /trace-turn-1/, markdown);
    assert.equal((markdown.match(/^## Tool Call: bash \(success\)$/gm) ?? []).length, 2, markdown);
    assert.match(markdown, /^## Summary/m, markdown);

    assert.equal(existsSync(assetMapPath), true, `missing asset map: ${assetMapPath}`);
    const assetMap = JSON.parse(readFileSync(assetMapPath, "utf8"));
    const entries = Object.entries(assetMap.sessions ?? {});
    assert.equal(entries.length, 1, JSON.stringify(assetMap, null, 2));
    const [, assets] = entries[0];
    assert.deepEqual(assets.markdown, { path: markdownPath });
    assert.equal(typeof assets.lark?.documentToken, "string", JSON.stringify(assetMap, null, 2));
  },
);

function findMarkdownFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return findMarkdownFiles(path);
    return entry.isFile() && entry.name.endsWith(".md") ? [path] : [];
  });
}
