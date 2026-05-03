import { toPositiveNumber } from "@bb/domain";
import type { ThreadContextWindowUsage } from "@bb/server-contract";
import type { ThreadEventWithMeta } from "./build-event-projection.js";

interface ThreadContextWindowSignal {
  estimated: boolean;
  modelContextWindow: number | null;
  usedTokens: number | null;
}

function toNonNegativeNumber(value: number): number | null {
  if (!Number.isFinite(value) || value < 0) {
    return null;
  }
  return value;
}

function decodeContextWindowSignal(
  eventWithMeta: ThreadEventWithMeta,
): ThreadContextWindowSignal | null {
  const { event } = eventWithMeta;
  if (event.type !== "thread/contextWindowUsage/updated") {
    return null;
  }
  const { contextWindowUsage } = event;
  return {
    usedTokens:
      contextWindowUsage.usedTokens === null
        ? null
        : toNonNegativeNumber(contextWindowUsage.usedTokens),
    modelContextWindow:
      contextWindowUsage.modelContextWindow === null
        ? null
        : (toPositiveNumber(contextWindowUsage.modelContextWindow) ?? null),
    estimated: contextWindowUsage.estimated,
  };
}

function getOrderedContextWindowEvents(
  events: readonly ThreadEventWithMeta[],
): readonly ThreadEventWithMeta[] {
  for (let index = 1; index < events.length; index += 1) {
    if (events[index - 1].meta.seq > events[index].meta.seq) {
      return [...events].sort((left, right) => left.meta.seq - right.meta.seq);
    }
  }
  return events;
}

export function extractThreadContextWindowUsage(
  events: readonly ThreadEventWithMeta[],
): ThreadContextWindowUsage | null {
  let estimated: boolean | undefined;
  let modelContextWindow: number | undefined;
  let usedTokens: number | undefined;
  let usageIsUnknown = false;
  const orderedEvents = getOrderedContextWindowEvents(events);

  for (let index = orderedEvents.length - 1; index >= 0; index -= 1) {
    const signal = decodeContextWindowSignal(orderedEvents[index]);
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

    if (
      (usedTokens !== undefined || usageIsUnknown) &&
      modelContextWindow !== undefined
    ) {
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
