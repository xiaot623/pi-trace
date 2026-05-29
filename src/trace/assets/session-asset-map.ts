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
    };

    mkdirSync(dirname(assetMapPath), { recursive: true });
    writeFileSync(assetMapPath, JSON.stringify(map, null, 2) + "\n", "utf8");
  } catch (error) {
    console.warn(`[trace] Failed to update session asset map ${assetMapPath}:`, error);
  }
}

function loadSessionAssetMap(assetMapPath: string): SessionAssetMap {
  if (!existsSync(assetMapPath)) {
    return { sessions: {} };
  }

  const content = readFileSync(assetMapPath, "utf8");
  const parsed = JSON.parse(content) as Partial<SessionAssetMap>;
  return {
    sessions: parsed.sessions && typeof parsed.sessions === "object" ? parsed.sessions : {},
  };
}
