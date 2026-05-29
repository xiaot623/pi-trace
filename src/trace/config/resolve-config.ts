import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DEFAULT_CONFIG } from "./default-config.js";
import type { ConsoleConfig, MarkdownConfig, ResolveConfigOptions, TraceConfig, TraceUserConfig } from "./types.js";

const CONFIG_FILE_NAME = "pi-trace.config.json";

export function resolveConfig(options: ResolveConfigOptions = {}): TraceConfig {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? detectEnv();
  const assetDir = resolve(cwd, "dev_assets");

  // 1. Load config file based on environment
  const configPath = getConfigPath(env, assetDir);
  ensureDefaultConfigFile(configPath);
  const fileConfig = loadConfigFile(configPath);

  // 2. Merge: defaults <- file <- programmatic override
  const merged = mergeConsumerConfigs(
    DEFAULT_CONFIG,
    fileConfig?.consumers,
    options.config?.consumers,
  ) as { console: ConsoleConfig; markdown: MarkdownConfig };

  return {
    assetDir,
    console: {
      enabled: merged.console.enabled,
      filter: merged.console.filter,
    },
    markdown: {
      enabled: merged.markdown.enabled,
    },
  };
}

function detectEnv(): "development" | "production" {
  return process.env.NODE_ENV === "production" ? "production" : "development";
}

function getConfigPath(env: string, assetDir: string): string {
  if (env === "production") {
    return process.env.PI_TRACE_CONFIG ?? join(homedir(), ".config", "pi-trace", CONFIG_FILE_NAME);
  }
  return join(assetDir, CONFIG_FILE_NAME);
}

function loadConfigFile(configPath: string): TraceUserConfig | undefined {
  if (!existsSync(configPath)) {
    return undefined;
  }

  try {
    const content = readFileSync(configPath, "utf8");
    return JSON.parse(content) as TraceUserConfig;
  } catch (error) {
    console.warn(`[trace] Failed to load config from ${configPath}:`, error);
    return undefined;
  }
}

function ensureDefaultConfigFile(configPath: string): void {
  if (existsSync(configPath)) {
    return;
  }

  const defaultFileContent = {
    consumers: {
      console: {
        enabled: DEFAULT_CONFIG.console.enabled,
        filter: DEFAULT_CONFIG.console.filter,
      },
      markdown: {
        enabled: DEFAULT_CONFIG.markdown.enabled,
      },
    },
  };

  try {
    const dir = dirname(configPath);
    mkdirSync(dir, { recursive: true });
    writeFileSync(configPath, JSON.stringify(defaultFileContent, null, 2) + "\n", "utf8");
  } catch {
    // Silently skip if directory is not writable (e.g. read-only filesystem)
  }
}

function mergeConsumerConfigs(
  defaults: Record<string, unknown>,
  ...overrides: Array<Record<string, unknown> | undefined>
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...defaults };

  for (const override of overrides) {
    if (!override) continue;
    for (const [key, value] of Object.entries(override)) {
      if (value && typeof value === "object" && !Array.isArray(value)) {
        const existing = result[key];
        result[key] =
          existing && typeof existing === "object" && !Array.isArray(existing)
            ? { ...(existing as Record<string, unknown>), ...(value as Record<string, unknown>) }
            : value;
      }
    }
  }

  return result;
}


