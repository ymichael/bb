import { describe, expect, it } from "vitest";
import type { TimelineRow } from "@bb/server-contract";
import { createTimelineLatestRowsCache } from "../../../src/services/threads/timeline-latest-rows-cache.js";

function rows(label: string): TimelineRow[] {
  return [
    {
      id: `row-${label}`,
      kind: "system",
      threadId: "thr_x",
      turnId: null,
      sourceSeqStart: 0,
      sourceSeqEnd: 0,
      startedAt: 0,
      createdAt: 0,
      systemKind: "debug",
      title: label,
      detail: null,
      status: null,
    },
  ];
}

describe("createTimelineLatestRowsCache", () => {
  it("keeps a ring of recent revisions per params key and evicts the oldest", () => {
    const cache = createTimelineLatestRowsCache({ ringSize: 3 });
    for (const maxSeq of [1, 2, 3]) {
      cache.set("k", { maxSeq, rows: rows(`r${maxSeq}`) });
    }
    expect(cache.get("k", 1)?.rows).toEqual(rows("r1"));
    expect(cache.get("k", 3)?.rows).toEqual(rows("r3"));

    cache.set("k", { maxSeq: 4, rows: rows("r4") });
    expect(cache.get("k", 1)).toBeUndefined();
    expect(cache.get("k", 2)?.rows).toEqual(rows("r2"));
    expect(cache.get("k", 4)?.rows).toEqual(rows("r4"));
    expect(cache.get("k", 5)).toBeUndefined();
    expect(cache.get("other", 4)).toBeUndefined();
  });

  it("a repeated set at the same revision refreshes recency without consuming a ring slot", () => {
    const cache = createTimelineLatestRowsCache({ ringSize: 2 });
    cache.set("k", { maxSeq: 1, rows: rows("r1") });
    cache.set("k", { maxSeq: 2, rows: rows("r2") });
    cache.set("k", { maxSeq: 1, rows: rows("r1") });
    cache.set("k", { maxSeq: 1, rows: rows("r1") });
    expect(cache.get("k", 1)?.rows).toEqual(rows("r1"));
    expect(cache.get("k", 2)?.rows).toEqual(rows("r2"));
    cache.set("k", { maxSeq: 3, rows: rows("r3") });
    expect(cache.get("k", 2)).toBeUndefined();
    expect(cache.get("k", 1)?.rows).toEqual(rows("r1"));
    expect(cache.get("k", 3)?.rows).toEqual(rows("r3"));
  });

  it("bounds params keys LRU-style; a lookup counts as use", () => {
    const cache = createTimelineLatestRowsCache({ maxEntries: 2 });
    cache.set("a", { maxSeq: 1, rows: rows("a") });
    cache.set("b", { maxSeq: 1, rows: rows("b") });
    expect(cache.get("a", 1)).toBeDefined();
    cache.set("c", { maxSeq: 1, rows: rows("c") });
    expect(cache.size).toBe(2);
    expect(cache.get("b", 1)).toBeUndefined();
    expect(cache.get("a", 1)?.rows).toEqual(rows("a"));
    expect(cache.get("c", 1)?.rows).toEqual(rows("c"));
  });
});
