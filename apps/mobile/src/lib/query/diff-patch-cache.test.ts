import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeSocketFactory } from "../realtime/fake-socket";
import { createMobileRealtime } from "../realtime/mobile-realtime";
import {
  getDiffPatchEvictionGeneration,
  readDiffPatchEntry,
  removeAllDiffPatchQueries,
  removeEnvironmentDiffPatchQueries,
  retainDiffPatchQueries,
  writeDiffPatchEntry,
} from "./diff-patch-cache";
import { installRealtimeInvalidation } from "./realtime-invalidation";

const identity = {
  environmentId: "env_1",
  targetType: "all",
  targetKey: "main",
};
const entry = {
  path: "a.ts",
  patch: "diff --git a/a.ts b/a.ts",
  truncated: false,
};

describe("diff-patch-cache", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("reads back a written patch under its (environment, target, path) key", () => {
    const queryClient = new QueryClient();
    expect(readDiffPatchEntry(queryClient, identity, "a.ts")).toBeUndefined();
    writeDiffPatchEntry(queryClient, identity, entry);
    expect(readDiffPatchEntry(queryClient, identity, "a.ts")).toEqual(entry);
    expect(
      readDiffPatchEntry(
        queryClient,
        { ...identity, targetType: "uncommitted", targetKey: null },
        "a.ts",
      ),
    ).toBeUndefined();
  });

  it("eviction removes the environment's patches and bumps its generation", () => {
    const queryClient = new QueryClient();
    writeDiffPatchEntry(queryClient, identity, entry);
    writeDiffPatchEntry(
      queryClient,
      { ...identity, environmentId: "env_2" },
      entry,
    );
    expect(getDiffPatchEvictionGeneration(queryClient, "env_1")).toBe(0);
    removeEnvironmentDiffPatchQueries(queryClient, "env_1");
    expect(getDiffPatchEvictionGeneration(queryClient, "env_1")).toBe(1);
    expect(getDiffPatchEvictionGeneration(queryClient, "env_2")).toBe(0);
    expect(readDiffPatchEntry(queryClient, identity, "a.ts")).toBeUndefined();
    expect(
      readDiffPatchEntry(
        queryClient,
        { ...identity, environmentId: "env_2" },
        "a.ts",
      ),
    ).toEqual(entry);
    removeAllDiffPatchQueries(queryClient);
    expect(getDiffPatchEvictionGeneration(queryClient, "env_2")).toBe(1);
    expect(getDiffPatchEvictionGeneration(queryClient, "env_1")).toBe(2);
    expect(
      readDiffPatchEntry(
        queryClient,
        { ...identity, environmentId: "env_2" },
        "a.ts",
      ),
    ).toBeUndefined();
  });

  it("generations are per QueryClient", () => {
    const first = new QueryClient();
    const second = new QueryClient();
    removeEnvironmentDiffPatchQueries(first, "env_1");
    expect(getDiffPatchEvictionGeneration(first, "env_1")).toBe(1);
    expect(getDiffPatchEvictionGeneration(second, "env_1")).toBe(0);
  });

  it("retains patches while a reader holds the lease and evicts after the last release", () => {
    const queryClient = new QueryClient();
    writeDiffPatchEntry(queryClient, identity, entry);
    const releaseA = retainDiffPatchQueries(queryClient, "env_1", 1_000);
    const releaseB = retainDiffPatchQueries(queryClient, "env_1", 1_000);
    releaseA();
    releaseA();
    vi.advanceTimersByTime(5_000);
    expect(readDiffPatchEntry(queryClient, identity, "a.ts")).toEqual(entry);
    releaseB();
    vi.advanceTimersByTime(999);
    expect(readDiffPatchEntry(queryClient, identity, "a.ts")).toEqual(entry);
    const releaseC = retainDiffPatchQueries(queryClient, "env_1", 1_000);
    vi.advanceTimersByTime(5_000);
    expect(readDiffPatchEntry(queryClient, identity, "a.ts")).toEqual(entry);
    releaseC();
    vi.advanceTimersByTime(1_000);
    expect(readDiffPatchEntry(queryClient, identity, "a.ts")).toBeUndefined();
    expect(getDiffPatchEvictionGeneration(queryClient, "env_1")).toBe(1);
  });

  it("a realtime workspace change evicts the patches before the TOC invalidation", () => {
    const factory = createFakeSocketFactory();
    const realtime = createMobileRealtime({
      url: "ws://x/ws",
      socketFactory: factory,
      onInvalidMessage: () => {},
    });
    const queryClient = new QueryClient();
    const order: string[] = [];
    vi.spyOn(queryClient, "invalidateQueries").mockImplementation(
      async (filters) => {
        order.push(`invalidate:${String(filters?.queryKey?.[0])}`);
      },
    );
    const removeSpy = vi.spyOn(queryClient, "removeQueries");
    removeSpy.mockImplementation((filters) => {
      order.push(`remove:${String(filters?.queryKey?.[0])}`);
    });
    const handle = installRealtimeInvalidation(queryClient, realtime);
    realtime.connect();
    factory.latest().open();
    factory.latest().receive(
      JSON.stringify({
        type: "changed",
        entity: "environment",
        id: "env_1",
        changes: ["work-status-changed"],
      }),
    );
    handle.flush();
    expect(getDiffPatchEvictionGeneration(queryClient, "env_1")).toBe(1);
    expect(order[0]).toBe("remove:environmentDiffPatch");
    expect(order).toContain("invalidate:environmentDiffFiles");
    expect(order.indexOf("remove:environmentDiffPatch")).toBeLessThan(
      order.indexOf("invalidate:environmentDiffFiles"),
    );
    handle.dispose();
  });
});
