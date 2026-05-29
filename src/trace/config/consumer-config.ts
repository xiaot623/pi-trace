import { join, resolve } from "node:path";
import { homedir } from "node:os";

export type TraceRuntimeMode = "development" | "production";

export interface TraceConsumerConfigInput {
  env?: Record<string, string | undefined>;
  cwd?: string;
  homeDir?: string;
  now?: Date;
}

export interface ConsoleConsumerConfig {
  enabled: boolean;
}

export interface MarkdownConsumerConfig {
  enabled: boolean;
  outputPath: string;
}

export interface TraceConsumerConfig {
  mode: TraceRuntimeMode;
  assetDir: string;
  console: ConsoleConsumerConfig;
  markdown: MarkdownConsumerConfig;
}

export function resolveTraceConsumerConfig(input: TraceConsumerConfigInput = {}): TraceConsumerConfig {
  const env = input.env ?? process.env;
  const cwd = input.cwd ?? process.cwd();
  const home = input.homeDir ?? homedir();
  const mode = resolveMode(env);
  const assetDir = env.PI_TRACE_ASSET_DIR || defaultAssetDir(mode, cwd, home);
  const now = input.now ?? new Date();

  return {
    mode,
    assetDir,
    console: {
      enabled: parseEnabled(env.PI_TRACE_CONSOLE_ENABLED, true),
    },
    markdown: {
      enabled: parseEnabled(env.PI_TRACE_MARKDOWN_ENABLED, true),
      outputPath: env.PI_TRACE_MARKDOWN_PATH || defaultMarkdownPath(assetDir, now),
    },
  };
}

function resolveMode(env: Record<string, string | undefined>): TraceRuntimeMode {
  const raw = (env.PI_TRACE_MODE ?? env.NODE_ENV ?? "development").trim().toLowerCase();
  return raw === "production" || raw === "prod" ? "production" : "development";
}

function defaultAssetDir(mode: TraceRuntimeMode, cwd: string, home: string): string {
  if (mode === "production") return join(home, ".pi-trace");
  return resolve(cwd, "dev_assets");
}

function defaultMarkdownPath(assetDir: string, now: Date): string {
  return join(assetDir, "markdown", `trace-${formatTimestamp(now)}.md`);
}

function formatTimestamp(date: Date): string {
  return date.toISOString().replace(/[:.]/g, "-");
}

function parseEnabled(raw: string | undefined, defaultValue: boolean): boolean {
  if (raw === undefined) return defaultValue;
  const normalized = raw.trim().toLowerCase();
  if (["0", "false", "no", "off", "disabled"].includes(normalized)) return false;
  if (["1", "true", "yes", "on", "enabled"].includes(normalized)) return true;
  return defaultValue;
}
