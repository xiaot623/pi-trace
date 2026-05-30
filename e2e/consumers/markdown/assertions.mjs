import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";

/**
 * 递归收集目录下所有 .md 文件路径。
 * @param {string} dir
 * @returns {string[]}
 */
export function findMarkdownFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return findMarkdownFiles(path);
    return entry.isFile() && entry.name.endsWith(".md") ? [path] : [];
  });
}

/**
 * 验证 markdown 目录已创建且恰好包含一个 .md 文件。
 * @param {string} markdownDir
 * @returns {string[]} markdownFiles
 */
export function assertMarkdownCreated(markdownDir) {
  assert.equal(existsSync(markdownDir), true, `missing markdown dir: ${markdownDir}`);
  const files = findMarkdownFiles(markdownDir);
  assert.equal(
    files.length,
    1,
    `expected one markdown file under ${markdownDir}, got ${files.join(", ")}`,
  );
  return files;
}

/**
 * 验证单轮 pi run 生成的 markdown 内容结构。
 * @param {string[]} markdownFiles
 */
export function assertSingleTurnMarkdown(markdownFiles) {
  const markdown = readFileSync(markdownFiles[0], "utf8");
  assert.match(basename(markdownFiles[0]), /^\d{8}_.+\.md$/);
  assert.match(markdown, /^# \d{8} .+/m, markdown);
  assert.match(markdown, /^## User/m, markdown);
  assert.match(markdown, /^## Assistant/m, markdown);
  assert.match(markdown, /^## Tool Call: bash \(success\)$/m, markdown);
  assert.match(markdown, /```json\n[\s\S]*echo trace-ok[\s\S]*\n```/, markdown);
  assert.match(markdown, /```text\n[\s\S]*trace-ok[\s\S]*\n```/, markdown);
  assert.match(markdown, /^> \*\*Tokens:\*\*/m, markdown);
}

/**
 * 验证多轮 pi run 生成的 markdown 内容结构。
 * @param {string[]} markdownFiles
 */
export function assertMultiTurnMarkdown(markdownFiles) {
  const markdown = readFileSync(markdownFiles[0], "utf8");
  assert.match(markdown, /trace-turn-0/, markdown);
  assert.match(markdown, /trace-turn-1/, markdown);
  assert.equal(
    (markdown.match(/^## Tool Call: bash \(success\)$/gm) ?? []).length,
    2,
    markdown,
  );
  assert.match(markdown, /^> \*\*Tokens:\*\*/m, markdown);
}
