import {
  isThreadEventRowOfType,
  toPositiveNumber,
  type ThreadEventRow,
} from "@bb/domain";

interface ThreadContextWindowSignal {
  estimated: boolean;
  modelContextWindow: number | null;
  usedTokens: number | null;
}

interface ContextWindowUsage {
  estimated: boolean;
  modelContextWindow: number;
  usedTokens: number;
}

function toNonNegativeNumber(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return value;
}

function decodeContextWindowSignal(event: ThreadEventRow): ThreadContextWindowSignal | null {
  if (isThreadEventRowOfType(event, "thread/contextWindowUsage/updated")) {
    const contextWindowUsage = event.data.contextWindowUsage;
    return {
      usedTokens:
        contextWindowUsage.usedTokens === null
          ? null
          : (toNonNegativeNumber(contextWindowUsage.usedTokens) ?? null),
      modelContextWindow:
        contextWindowUsage.modelContextWindow === null
          ? null
          : (toPositiveNumber(contextWindowUsage.modelContextWindow) ?? null),
      estimated: contextWindowUsage.estimated,
    };
  }
  return null;
}

export function extractThreadContextWindowUsage(
  events: readonly ThreadEventRow[],
): ContextWindowUsage | null {
  let estimated: boolean | undefined;
  let modelContextWindow: number | undefined;
  let usedTokens: number | undefined;
  let usageIsUnknown = false;

  for (let index = events.length - 1; index >= 0; index -= 1) {
    const signal = decodeContextWindowSignal(events[index]);
    if (!signal) continue;

    if (usedTokens === undefined && !usageIsUnknown) {
      if (signal.usedTokens === null) {
        usageIsUnknown = true;
        estimated = signal.estimated;
      } else {
        usedTokens = signal.usedTokens;
        estimated = signal.estimated;
      }
    }

    if (
      modelContextWindow === undefined &&
      signal.modelContextWindow !== null
    ) {
      modelContextWindow = signal.modelContextWindow;
    }

    if ((usedTokens !== undefined || usageIsUnknown) && modelContextWindow !== undefined) {
      break;
    }
  }

  if (usedTokens === undefined || modelContextWindow === undefined) {
    return null;
  }

  return {
    estimated: estimated ?? false,
    modelContextWindow,
    usedTokens,
  };
}
