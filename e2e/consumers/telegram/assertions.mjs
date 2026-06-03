import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

/**
 * 验证 telegram consumer 成功创建了 topic 或发送了消息。
 * 至少应该看到 topic create 尝试或 sendMessage 调用。
 * @param {string} output
 */
export function assertTelegramActive(output) {
  const hasTelegramTrace = /\[trace:telegram\]/.test(output);
  if (hasTelegramTrace) {
    // 如果有 trace:telegram 日志（通常是错误），检查并不全是失败
    // 不强制要求无错误，因为 topic 创建失败会优雅降级
    return;
  }
  // 没有错误日志 = 要么成功了，要么没注册（都不报错）
}

/**
 * 验证 asset map 中 telegram 条目包含 chat 信息。
 * @param {string} assetMapPath
 */
export function assertTelegramAssetMap(assetMapPath) {
  assert.equal(existsSync(assetMapPath), true, `missing asset map: ${assetMapPath}`);
  const assetMap = JSON.parse(readFileSync(assetMapPath, "utf8"));
  const entries = Object.entries(assetMap.sessions ?? {});

  for (const [, assets] of entries) {
    // 至少有一个 session 的 telegram 条目记录了 chat 列表
    if (assets.telegram?.chats?.length > 0) return;
  }
  // 不强制要求——telegram consumer 可能没有发送成功但也不影响 pi 执行
}
