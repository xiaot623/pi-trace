import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultTimeoutMs, formatFailure, runPiTraceE2E } from "../../helpers/pi-runner.mjs";

test(
  "markdown consumer writes a batch execution document in a real pi run",
  { timeout: defaultTimeoutMs + 10_000 },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-trace-e2e-md-"));
    const outputPath = join(dir, "trace.md");

    try {
      const result = await runPiTraceE2E({
        env: {
          PI_TRACE_MARKDOWN_PATH: outputPath,
          PI_TRACE_KINDS: "batch",
        },
      });

      assert.equal(result.code, 0, formatFailure(result));

      const markdown = readFileSync(outputPath, "utf8");
      assert.match(markdown, /^# Pi Trace/m, markdown);
      assert.match(markdown, /^## User/m, markdown);
      assert.match(markdown, /^## Thinking/m, markdown);
      assert.match(markdown, /^## Assistant/m, markdown);
      assert.match(markdown, /^## Tool Call/m, markdown);
      assert.match(markdown, /^## Summary/m, markdown);
      assert.match(markdown, /trace-ok/, markdown);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
