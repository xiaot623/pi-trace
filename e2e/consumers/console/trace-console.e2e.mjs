import test from "node:test";
import assert from "node:assert/strict";
import { defaultTimeoutMs, formatFailure, runPiTraceE2E } from "../../helpers/pi-runner.mjs";

test(
  "console consumer emits realtime and batch events in a real pi run",
  { timeout: defaultTimeoutMs + 10_000 },
  async () => {
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
  },
);
