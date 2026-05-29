import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DEFAULT_CONFIG } from "./default-config.js";
import type { ConsoleConfig, LarkConfig, MarkdownConfig, ResolveConfigOptions, TraceConfig, TraceUserConfig } from "./types.js";

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
  ) as { console: ConsoleConfig; markdown: MarkdownConfig; lark: LarkConfig };

  return {
    assetDir,
    console: {
      enabled: merged.console.enabled,
      filter: merged.console.filter,
    },
    markdown: {
      enabled: merged.markdown.enabled,
    },
    lark: {
      enabled: merged.lark.enabled,
      wiki_space_id: merged.lark.wiki_space_id,
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
  const defaultConsumers: Record<string, unknown> = {
    console: {
      enabled: DEFAULT_CONFIG.console.enabled,
      filter: DEFAULT_CONFIG.console.filter,
    },
    markdown: {
      enabled: DEFAULT_CONFIG.markdown.enabled,
    },
    lark: {
      enabled: DEFAULT_CONFIG.lark.enabled,
      wiki_space_id: DEFAULT_CONFIG.lark.wiki_space_id,
    },
  };

  try {
    if (existsSync(configPath)) {
      // File exists — backfill any new consumer keys the user hasn't configured yet
      const content = readFileSync(configPath, "utf8");
      const parsed = JSON.parse(content) as Record<string, unknown>;
      const consumers = (parsed.consumers && typeof parsed.consumers === "object"
        ? parsed.consumers
        : {}) as Record<string, unknown>;

      let changed = false;
      for (const [key, defaultValue] of Object.entries(defaultConsumers)) {
        if (!(key in consumers)) {
          consumers[key] = defaultValue;
          changed = true;
        }
      }

      if (changed) {
        parsed.consumers = consumers;
        writeFileSync(configPath, JSON.stringify(parsed, null, 2) + "\n", "utf8");
      }
      return;
    }

    // File doesn't exist — create with all defaults
    const dir = dirname(configPath);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      configPath,
      JSON.stringify({ consumers: defaultConsumers }, null, 2) + "\n",
      "utf8",
    );
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
