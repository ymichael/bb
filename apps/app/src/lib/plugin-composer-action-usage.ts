import { useSyncExternalStore } from "react";
import { z } from "zod";

export const PLUGIN_COMPOSER_ACTION_USAGE_STORAGE_KEY =
  "bb.pluginComposerActionUsage.v1";

const MAX_TRACKED_PLUGINS = 128;
const MAX_USAGE_COUNT = 1_000_000_000;
const EMPTY_USAGE_COUNTS: Readonly<Record<string, number>> = Object.freeze({});

const usageCountsSchema = z.record(
  z.string().min(1),
  z.number().int().nonnegative().max(MAX_USAGE_COUNT),
);

let initialized = false;
let snapshot: Readonly<Record<string, number>> = EMPTY_USAGE_COUNTS;
const listeners = new Set<() => void>();

function readUsageCounts(): Readonly<Record<string, number>> {
  if (typeof window === "undefined") return EMPTY_USAGE_COUNTS;
  const storedValue = window.localStorage.getItem(
    PLUGIN_COMPOSER_ACTION_USAGE_STORAGE_KEY,
  );
  if (storedValue === null) return EMPTY_USAGE_COUNTS;

  let parsedValue: unknown;
  try {
    parsedValue = JSON.parse(storedValue);
  } catch {
    return EMPTY_USAGE_COUNTS;
  }
  const result = usageCountsSchema.safeParse(parsedValue);
  return result.success ? result.data : EMPTY_USAGE_COUNTS;
}

function getSnapshot(): Readonly<Record<string, number>> {
  if (!initialized) {
    initialized = true;
    snapshot = readUsageCounts();
  }
  return snapshot;
}

function emitChange(): void {
  for (const listener of listeners) listener();
}

function replaceSnapshot(next: Readonly<Record<string, number>>): void {
  initialized = true;
  snapshot = next;
  emitChange();
}

function handleStorage(event: StorageEvent): void {
  if (event.key !== PLUGIN_COMPOSER_ACTION_USAGE_STORAGE_KEY) return;
  replaceSnapshot(readUsageCounts());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1 && typeof window !== "undefined") {
    window.addEventListener("storage", handleStorage);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && typeof window !== "undefined") {
      window.removeEventListener("storage", handleStorage);
    }
  };
}

function pruneUsageCounts(
  counts: Readonly<Record<string, number>>,
): Readonly<Record<string, number>> {
  const entries = Object.entries(counts);
  if (entries.length <= MAX_TRACKED_PLUGINS) return counts;
  return Object.fromEntries(
    entries
      .sort(
        ([leftId, leftCount], [rightId, rightCount]) =>
          rightCount - leftCount || leftId.localeCompare(rightId),
      )
      .slice(0, MAX_TRACKED_PLUGINS),
  );
}

export function recordPluginComposerActionUse(pluginId: string): void {
  const current = getSnapshot();
  const next = pruneUsageCounts({
    ...current,
    [pluginId]: Math.min((current[pluginId] ?? 0) + 1, MAX_USAGE_COUNT),
  });
  if (typeof window !== "undefined") {
    window.localStorage.setItem(
      PLUGIN_COMPOSER_ACTION_USAGE_STORAGE_KEY,
      JSON.stringify(next),
    );
  }
  replaceSnapshot(next);
}

export function usePluginComposerActionUsage(): Readonly<
  Record<string, number>
> {
  return useSyncExternalStore(subscribe, getSnapshot, () => EMPTY_USAGE_COUNTS);
}

export function resetPluginComposerActionUsageForTest(): void {
  initialized = false;
  snapshot = EMPTY_USAGE_COUNTS;
  emitChange();
}
