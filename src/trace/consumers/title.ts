export function formatTraceDate(timestamp: number): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "unknown-date";
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}${month}${day}`;
}

export function formatTraceMonth(timestamp: number): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "unknown-month";
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

export function buildTraceTitle(timestamp: number, subject?: string): string {
  return `${formatTraceDate(timestamp)} ${subject?.trim() || "Pi Trace"}`;
}

export function buildSubjectFirstTitle(timestamp: number, subject?: string): string {
  return `${subject?.trim() || "Pi Trace"} ${formatTraceDate(timestamp)}`;
}

export function sanitizeTraceFileName(title: string): string {
  return title.replace(/[^a-zA-Z0-9_\-\u4e00-\u9fa5]/g, "_").slice(0, 120);
}

export function deriveTraceTitleSubject(payload: Record<string, unknown>): string | undefined {
  const sessionName = firstMeaningfulLine(payload.sessionName);
  if (sessionName) return sessionName;

  const userInput = firstMeaningfulLine(payload.userInput);
  if (userInput) return userInput;

  const input = firstMeaningfulLine(payload.input);
  if (input) return input;

  if (payload.role === "user") {
    const content = contentToTitleText(payload.content);
    if (content) return content;
  }

  return undefined;
}

function firstMeaningfulLine(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return value.trim().split("\n")[0]?.trim().slice(0, 100) || undefined;
}

function contentToTitleText(content: unknown): string | undefined {
  if (typeof content === "string") return firstMeaningfulLine(content);
  if (!Array.isArray(content)) return undefined;

  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const item = block as Record<string, unknown>;
    if (item.type === "text") return firstMeaningfulLine(item.text);
  }
  return undefined;
}
