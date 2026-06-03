import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "./pi-runner.mjs";

export const assetDir = join(repoRoot, "dev_assets");
export const markdownDir = join(repoRoot, "dev_assets", "markdown");
export const configPath = join(repoRoot, "dev_assets", "pi-trace.config.json");
export const assetMapPath = join(repoRoot, "dev_assets", "pi-trace.assets.json");

/**
 * 从 dev_assets/pi-trace.config.json 读取消费者配置。
 * 如果文件不存在则返回所有 consumer 默认关闭的空配置。
 * @returns {{ consumers: Record<string, { enabled?: boolean }> }}
 */
export function readConfig() {
  if (!existsSync(configPath)) {
    return { consumers: {} };
  }
  try {
    return JSON.parse(readFileSync(configPath, "utf8"));
  } catch {
    return { consumers: {} };
  }
}

/**
 * 判断指定 consumer 是否启用。
 * @param {{ consumers: Record<string, { enabled?: boolean }> }} config
 * @param {string} name - consumer 名称（console / markdown / lark / telegram）
 * @returns {boolean}
 */
export function isConsumerEnabled(config, name) {
  return !!config?.consumers?.[name]?.enabled;
}

/**
 * 清理本次 e2e 运行产生的产物目录和 asset map。
 */
export function cleanupArtifacts() {
  rmSync(markdownDir, { recursive: true, force: true });
  rmSync(assetMapPath, { force: true });
}

/**
 * 合并 stdout 和 stderr 为单一字符串，方便断言。
 * @param {{ stdout: string; stderr: string }} result
 */
export function combineOutput(result) {
  return `${result.stdout}\n${result.stderr}`;
}
