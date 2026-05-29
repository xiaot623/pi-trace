import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { defaultTimeoutMs, formatFailure, repoRoot, runPiTraceE2E } from "./helpers/pi-runner.mjs";

const markdownDir = join(repoRoot, "dev_assets", "markdown");

test(
  "default development config runs all enabled consumers in one real pi run",
  { timeout: defaultTimeoutMs + 10_000 },
  async () => {
    rmSync(markdownDir, { recursive: true, force: true });

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
    const markdownFiles = readdirSync(markdownDir).filter((file) => file.endsWith(".md"));
    assert.equal(markdownFiles.length, 1, `expected one markdown file in ${markdownDir}, got ${markdownFiles.join(", ")}`);

    const markdown = readFileSync(join(markdownDir, markdownFiles[0]), "utf8");
    assert.match(markdown, /^# Pi Trace/m, markdown);
    assert.match(markdown, /^## User/m, markdown);
    assert.match(markdown, /^## Thinking/m, markdown);
    assert.match(markdown, /^## Assistant/m, markdown);
    assert.match(markdown, /^## Tool Call: bash \(success\)$/m, markdown);
    assert.match(markdown, /```json\n[\s\S]*echo trace-ok[\s\S]*\n```/, markdown);
    assert.match(markdown, /```text\n[\s\S]*trace-ok[\s\S]*\n```/, markdown);
    assert.match(markdown, /^## Summary/m, markdown);
  },
);
