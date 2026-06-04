import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Runtime values populated from CLI flags.
 * Consumers read from here; no need to know about pi flag APIs.
 */
export const overrides: Record<string, string> = {};

/**
 * Register all CLI flags and apply their values to the shared overrides record.
 * Call once during extension initialization.
 */
export function registerFlags(pi: ExtensionAPI): void {
  pi.registerFlag("topic", {
    description: "Existing Telegram forum topic message_thread_id (skip auto-creation)",
    type: "string",
  });

  const topic = pi.getFlag("topic");
  if (typeof topic === "string") overrides.telegramThreadId = topic;
}
