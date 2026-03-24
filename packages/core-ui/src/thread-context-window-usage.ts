import type { ThreadEventRow } from "@bb/domain";
import { isRecord } from "./unknown-helpers.js";

interface ThreadContextWindowSignal {
  totalTokens?: number;
  modelContextWindow?: number;
}

interface ContextWindowUsage {
  totalTokens: number;
  modelContextWindow: number;
}

function toNonNegativeNumber(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return value;
}

function toPositiveNumber(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return value;
}

function decodeContextWindowSignal(event: ThreadEventRow): ThreadContextWindowSignal | null {
  const payload = event.data;

  if (event.type === "thread/tokenUsage/updated") {
    const tokenUsage = isRecord(payload.tokenUsage) ? payload.tokenUsage : undefined;
    const totalUsage = isRecord(tokenUsage?.total) ? tokenUsage.total : undefined;
    const lastUsage = isRecord(tokenUsage?.last) ? tokenUsage.last : undefined;
    const totalTokens =
      toNonNegativeNumber(lastUsage?.totalTokens) ??
      toNonNegativeNumber(totalUsage?.totalTokens);
    const modelContextWindow = toPositiveNumber(tokenUsage?.modelContextWindow);
    if (totalTokens === undefined && modelContextWindow === undefined) {
      return null;
    }
    return {
      totalTokens,
      modelContextWindow,
    };
  }

  // Provider event methods are open_external: unknown methods are intentionally ignored.
  return null;
}

export function extractThreadContextWindowUsage(
  events: readonly ThreadEventRow[],
): ContextWindowUsage | null {
  let totalTokens: number | undefined;
  let modelContextWindow: number | undefined;

  for (let index = events.length - 1; index >= 0; index -= 1) {
    const signal = decodeContextWindowSignal(events[index]);
    if (!signal) continue;

    if (totalTokens === undefined && signal.totalTokens !== undefined) {
      totalTokens = signal.totalTokens;
    }

    if (
      modelContextWindow === undefined &&
      signal.modelContextWindow !== undefined
    ) {
      modelContextWindow = signal.modelContextWindow;
    }

    if (totalTokens !== undefined && modelContextWindow !== undefined) {
      break;
    }
  }

  if (modelContextWindow === undefined) {
    return null;
  }

  return {
    totalTokens: totalTokens ?? 0,
    modelContextWindow,
  };
}
