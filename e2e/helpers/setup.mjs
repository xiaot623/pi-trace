import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "./pi-runner.mjs";

export const assetDir = join(repoRoot, "dev_assets");
export const markdownDir = join(repoRoot, "dev_assets", "markdown");
export const configPath = join(repoRoot, "dev_assets", "pi-trace.config.json");
export const assetMapPath = join(repoRoot, "dev_assets", "pi-trace.assets.json");

/**
 * 写入启用全部 consumer 的配置文件。
 */
export function enableAllConsumers() {
  mkdirSync(assetDir, { recursive: true });
  writeFileSync(
    configPath,
    JSON.stringify(
      {
        consumers: {
          console: { enabled: true, filter: { kinds: ["both"] } },
          markdown: { enabled: true },
          lark: { enabled: true, wiki_space_id: process.env.WIKI_SPACE_ID ?? "" },
        },
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );
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
