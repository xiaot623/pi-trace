import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface SessionAssetMapEntry {
  markdown?: {
    path: string;
  };
  lark?: {
    documentToken: string;
    documentUrl?: string;
    wikiSpaceId?: string;
    month?: string;
    monthNodeToken?: string;
  };
  telegram?: {
    chats: Array<{
      chatId: string;
      topicName?: string;
      messageThreadId?: number;
      topicCreated?: boolean;
      topicClosed?: boolean;
      summaryMessageIds?: number[];
    }>;
    totals?: {
      loops?: number;
      turnCount?: number;
      messageCount?: number;
      toolCount?: number;
      errorCount?: number;
      durationMs?: number;
      inputTokens?: number;
      outputTokens?: number;
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
      totalTokens?: number;
      cost?: number;
    };
  };
}

export interface SessionAssetMap {
  sessions: Record<string, SessionAssetMapEntry>;
}

export function updateSessionAssetMap(
  assetMapPath: string | undefined,
  sessionId: string | undefined,
  assets: SessionAssetMapEntry,
): void {
  if (!assetMapPath || !sessionId) return;

  try {
    const map = loadSessionAssetMap(assetMapPath);
    const current = map.sessions[sessionId] ?? {};
    map.sessions[sessionId] = {
      ...current,
      ...assets,
      markdown: assets.markdown ?? current.markdown,
      lark: assets.lark ?? current.lark,
      telegram: assets.telegram ?? current.telegram,
    };

    mkdirSync(dirname(assetMapPath), { recursive: true });
    writeFileSync(assetMapPath, JSON.stringify(map, null, 2) + "\n", "utf8");
  } catch (error) {
    console.warn(`[trace] Failed to update session asset map ${assetMapPath}:`, error);
  }
}

export function loadSessionAssetMap(assetMapPath: string): SessionAssetMap {
  if (!existsSync(assetMapPath)) {
    return { sessions: {} };
  }

  const content = readFileSync(assetMapPath, "utf8");
  const parsed = JSON.parse(content) as Partial<SessionAssetMap>;
  return {
    sessions: parsed.sessions && typeof parsed.sessions === "object" ? parsed.sessions : {},
  };
}
