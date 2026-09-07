import type { TimelineRow } from "@bb/server-contract";

const DEFAULT_MAX_ENTRIES = 64;
const DEFAULT_RING_SIZE = 4;

interface TimelineLatestRows {
  maxSeq: number;
  rows: readonly TimelineRow[];
}

interface TimelineLatestRowsCache {
  get(paramsKey: string, maxSeq: number): TimelineLatestRows | undefined;
  set(paramsKey: string, value: TimelineLatestRows): void;
  readonly size: number;
}

export function createTimelineLatestRowsCache(
  options: { maxEntries?: number; ringSize?: number } = {},
): TimelineLatestRowsCache {
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const ringSize = options.ringSize ?? DEFAULT_RING_SIZE;
  const entries = new Map<string, TimelineLatestRows[]>();

  function touch(paramsKey: string, ring: TimelineLatestRows[]): void {
    entries.delete(paramsKey);
    entries.set(paramsKey, ring);
  }

  return {
    get(paramsKey, maxSeq) {
      const ring = entries.get(paramsKey);
      if (ring === undefined) {
        return undefined;
      }
      touch(paramsKey, ring);
      return ring.find((entry) => entry.maxSeq === maxSeq);
    },
    set(paramsKey, value) {
      const ring = entries.get(paramsKey) ?? [];
      const existingIndex = ring.findIndex(
        (entry) => entry.maxSeq === value.maxSeq,
      );
      if (existingIndex !== -1) {
        ring.splice(existingIndex, 1);
      }
      ring.push(value);
      while (ring.length > ringSize) {
        ring.shift();
      }
      touch(paramsKey, ring);
      while (entries.size > maxEntries) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) {
          break;
        }
        entries.delete(oldest);
      }
    },
    get size() {
      return entries.size;
    },
  };
}
