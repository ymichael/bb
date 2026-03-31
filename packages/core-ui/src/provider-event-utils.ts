/**
 * Utility functions for working with provider events and thread data.
 * These are not provider-specific — they operate on bb's own persisted types.
 */

import {
  isThreadEventRowOfType,
  type PromptInput,
  type ThreadEventRow,
} from "@bb/domain";

/**
 * Derive a thread title from prompt input text.
 * Extracts the first text chunk, collapses whitespace, and truncates to 60 chars.
 */
export function deriveThreadTitleFromInput(
  input?: PromptInput[],
): string | undefined {
  if (!input || input.length === 0) return undefined;
  const textChunk = input.find(
    (chunk): chunk is Extract<PromptInput, { type: "text" }> =>
      chunk.type === "text" && chunk.text.trim().length > 0,
  );
  if (!textChunk) return undefined;
  const normalized = textChunk.text.replace(/\s+/g, " ").trim();
  if (!normalized) return undefined;
  if (normalized.length <= 60) return normalized;
  return `${normalized.slice(0, 57).trimEnd()}...`;
}

/**
 * Extract agent message text from a persisted item/completed event.
 * Returns undefined if the event is not an agent message completion.
 */
export function outputFromThreadEvent(event: ThreadEventRow): string | undefined {
  if (!isThreadEventRowOfType(event, "item/completed")) return undefined;
  const item = event.data.item;
  if (item.type !== "agentMessage") return undefined;
  const text = item.text;
  return text || undefined;
}
