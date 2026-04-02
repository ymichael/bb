import {
  isThreadEventRowOfType,
  toPositiveNumber,
  type ThreadEventRow,
} from "@bb/domain";

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

function decodeContextWindowSignal(event: ThreadEventRow): ThreadContextWindowSignal | null {
  if (isThreadEventRowOfType(event, "thread/tokenUsage/updated")) {
    const tokenUsage = event.data.tokenUsage;
    const totalTokens = toNonNegativeNumber(tokenUsage.last.totalTokens);
    const modelContextWindow = toPositiveNumber(tokenUsage.modelContextWindow);
    if (totalTokens === undefined && modelContextWindow === undefined) {
      return null;
    }
    return {
      totalTokens,
      modelContextWindow,
    };
  }
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
