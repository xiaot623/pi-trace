import assert from "node:assert/strict";

/**
 * 验证 console consumer 的 realtime 事件输出。
 * @param {string} output
 */
export function assertConsoleRealtimeEvents(output) {
  assert.match(output, /\[trace realtime\] turn\.started/, output);
  assert.match(output, /\[trace realtime\] message\.started role=assistant/, output);
  assert.match(output, /\[trace realtime\] tool\.started bash/, output);
  assert.match(output, /\[trace realtime\] tool\.result bash/, output);
  assert.match(output, /\[trace realtime\] tool\.ended bash/, output);
}

/**
 * 验证 console consumer 的 batch 事件输出。
 * @param {string} output
 */
export function assertConsoleBatchEvents(output) {
  assert.match(output, /\[trace batch\] message\.record role=assistant/, output);
  assert.match(output, /\[trace batch\] tool\.record bash/, output);
  assert.match(output, /\[trace batch\] turn\.record turn=0/, output);
  assert.match(output, /\[trace batch\] agent\.run/, output);
}

/**
 * 验证多轮场景的 batch 事件（turn=0 和 turn=1）。
 * @param {string} output
 */
export function assertConsoleMultiTurnBatchEvents(output) {
  assert.match(output, /\[trace batch\] turn\.record turn=0/, output);
  assert.match(output, /\[trace batch\] turn\.record turn=1/, output);
}
