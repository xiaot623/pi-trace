import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

/**
 * 验证 lark consumer 成功创建了 wiki node。
 * @param {string} output
 */
export function assertLarkNodeCreated(output) {
  assert.match(output, /\[trace:lark\] created wiki node/, "lark consumer should create wiki node");
}

/**
 * 验证 lark consumer flush 成功。
 * @param {string} output
 */
export function assertLarkFlushOk(output) {
  assert.match(output, /\[trace:lark\] flush #\d+ ok/, "lark consumer should flush successfully");
}

/**
 * 验证 asset map 中 lark 条目包含 documentToken，且 markdown 路径正确关联。
 * @param {string} assetMapPath
 * @param {string[]} markdownFiles
 */
export function assertLarkAssetMap(assetMapPath, markdownFiles) {
  assert.equal(existsSync(assetMapPath), true, `missing asset map: ${assetMapPath}`);
  const assetMap = JSON.parse(readFileSync(assetMapPath, "utf8"));
  const entries = Object.entries(assetMap.sessions ?? {});
  assert.equal(entries.length, 1, JSON.stringify(assetMap, null, 2));
  const [, assets] = entries[0];
  assert.deepEqual(assets.markdown, { path: markdownFiles[0] });
  assert.equal(
    typeof assets.lark?.documentToken,
    "string",
    JSON.stringify(assetMap, null, 2),
  );
}
