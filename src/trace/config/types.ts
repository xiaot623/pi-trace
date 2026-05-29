import type { TraceConsumerFilter } from "../core/types.js";

// ============================================================================
// User Config (what goes in the JSON config file)
// ============================================================================

export interface ConsoleUserConfig {
  enabled?: boolean;
  filter?: TraceConsumerFilter;
}

export interface MarkdownUserConfig {
  enabled?: boolean;
}

export interface TraceUserConfig {
  consumers?: {
    console?: ConsoleUserConfig;
    markdown?: MarkdownUserConfig;
  };
}

// ============================================================================
// Resolved Config (after merge with defaults)
// ============================================================================

export interface ConsoleConfig {
  enabled: boolean;
  filter?: TraceConsumerFilter;
}

export interface MarkdownConfig {
  enabled: boolean;
}

export interface TraceConfig {
  assetDir: string;
  console: ConsoleConfig;
  markdown: MarkdownConfig;
}

// ============================================================================
// Resolve Options
// ============================================================================

export interface ResolveConfigOptions {
  cwd?: string;
  env?: "development" | "production";
  config?: TraceUserConfig;
}
