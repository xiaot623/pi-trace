import type { ConsoleConfig, LarkConfig, MarkdownConfig } from "./types.js";

export const DEFAULT_CONSOLE_CONFIG: ConsoleConfig = {
  enabled: false,
  filter: { kinds: ["both"] },
};

export const DEFAULT_MARKDOWN_CONFIG: MarkdownConfig = {
  enabled: false,
};

export const DEFAULT_LARK_CONFIG: LarkConfig = {
  enabled: false,
  wiki_space_id: "",
};

export const DEFAULT_CONFIG = {
  console: DEFAULT_CONSOLE_CONFIG,
  markdown: DEFAULT_MARKDOWN_CONFIG,
  lark: DEFAULT_LARK_CONFIG,
} as const;
