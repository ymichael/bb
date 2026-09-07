// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { WorkspaceDiffTarget } from "@bb/domain";
import type {
  DiffPatchEntry,
  EnvironmentDiffPatchResponse,
} from "@bb/server-contract";
import { createDeferredPromise } from "@bb/test-helpers";
import { sdk } from "@/lib/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import { removeEnvironmentDiffPatchQueries } from "../cache-owners/query-cache";
import { bumpAllDiffPatchEvictionGenerations } from "../cache-owners/environment-diff-patch-cache-owner";
import { environmentDiffPatchQueryKey } from "./query-keys";
import { HEAVY_PAYLOAD_GC_TIME_MS } from "./query-policies";
import { useEnvironmentDiffPatches } from "./use-environment-diff-patches";

vi.mock("@/lib/sdk", () => ({
  sdk: { environments: { diffPatch: vi.fn() } },
}));

const ENVIRONMENT_ID = "env-1";
const TARGET: WorkspaceDiffTarget = { type: "all", mergeBaseBranch: "main" };
const PATH = "file.ts";

function patchKey() {
  return environmentDiffPatchQueryKey(ENVIRONMENT_ID, "all", "main", PATH);
}

function availableResponse(
  entry: DiffPatchEntry,
): EnvironmentDiffPatchResponse {
  return { outcome: "available", patches: [entry] };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

beforeEach(() => {
  vi.mocked(sdk.environments.diffPatch).mockReset();
});

describe("useEnvironmentDiffPatches", () => {
  it("aborts in-flight patch fetches when the target changes", async () => {
    const { wrapper } = createQueryClientTestHarness();
    const changedTarget: WorkspaceDiffTarget = {
      type: "branch_committed",
      mergeBaseBranch: "main",
    };
    const firstFetch = createDeferredPromise<EnvironmentDiffPatchResponse>();
    vi.mocked(sdk.environments.diffPatch).mockReturnValue(firstFetch.promise);

    const { result, rerender } = renderHook(
      ({ target }) => useEnvironmentDiffPatches(ENVIRONMENT_ID, { target }),
      { wrapper, initialProps: { target: TARGET as WorkspaceDiffTarget } },
    );

    act(() => {
      result.current.requestPaths({ visible: [PATH], overscan: [] });
    });

    await waitFor(() => {
      expect(sdk.environments.diffPatch).toHaveBeenCalledTimes(1);
    });
    const request = vi.mocked(sdk.environments.diffPatch).mock.calls[0]?.[0];
    expect(request?.signal?.aborted).toBe(false);
    rerender({ target: changedTarget });

    expect(request?.signal?.aborted).toBe(true);
    expect(result.current.getPatchState(PATH).status).toBe("idle");
  });

  it("drops a patch fetch that resolves after a mid-flight eviction and re-fetches fresh", async () => {
    const { wrapper, queryClient } = createQueryClientTestHarness();

    const stalePatch: DiffPatchEntry = {
      path: PATH,
      patch: "diff --git a/file.ts b/file.ts\n+stale\n",
      truncated: false,
    };
    const freshPatch: DiffPatchEntry = {
      path: PATH,
      patch: "diff --git a/file.ts b/file.ts\n+fresh\n",
      truncated: false,
    };

    const firstFetch = createDeferredPromise<EnvironmentDiffPatchResponse>();
    vi.mocked(sdk.environments.diffPatch)
      .mockReturnValueOnce(firstFetch.promise)
      .mockResolvedValueOnce(availableResponse(freshPatch));

    const { result } = renderHook(
      () => useEnvironmentDiffPatches(ENVIRONMENT_ID, { target: TARGET }),
      { wrapper },
    );

    act(() => {
      result.current.requestPaths({ visible: [PATH], overscan: [] });
    });
    await waitFor(() => {
      expect(sdk.environments.diffPatch).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(result.current.getPatchState(PATH).status).toBe("loading");
    });

    act(() => {
      removeEnvironmentDiffPatchQueries({
        environmentId: ENVIRONMENT_ID,
        queryClient,
      });
    });

    await act(async () => {
      firstFetch.resolve(availableResponse(stalePatch));
      await firstFetch.promise;
    });

    await waitFor(() => {
      expect(result.current.getPatchState(PATH).status).toBe("idle");
    });
    expect(queryClient.getQueryData(patchKey())).toBeUndefined();

    act(() => {
      result.current.requestPaths({ visible: [PATH], overscan: [] });
    });
    await waitFor(() => {
      expect(sdk.environments.diffPatch).toHaveBeenCalledTimes(2);
    });
    await waitFor(() => {
      const state = result.current.getPatchState(PATH);
      expect(state.status).toBe("loaded");
      expect(state.patch).toBe(freshPatch.patch);
    });
    expect(queryClient.getQueryData<DiffPatchEntry>(patchKey())).toEqual(
      freshPatch,
    );
  });

  it("starts a fresh fetch when a visible path is re-requested after eviction while an older fetch is still loading", async () => {
    const { wrapper, queryClient } = createQueryClientTestHarness();

    const stalePatch: DiffPatchEntry = {
      path: PATH,
      patch: "diff --git a/file.ts b/file.ts\n+stale\n",
      truncated: false,
    };
    const freshPatch: DiffPatchEntry = {
      path: PATH,
      patch: "diff --git a/file.ts b/file.ts\n+fresh\n",
      truncated: false,
    };

    const firstFetch = createDeferredPromise<EnvironmentDiffPatchResponse>();
    vi.mocked(sdk.environments.diffPatch)
      .mockReturnValueOnce(firstFetch.promise)
      .mockResolvedValueOnce(availableResponse(freshPatch));

    const { result } = renderHook(
      () => useEnvironmentDiffPatches(ENVIRONMENT_ID, { target: TARGET }),
      { wrapper },
    );

    act(() => {
      result.current.requestPaths({ visible: [PATH], overscan: [] });
    });
    await waitFor(() => {
      expect(sdk.environments.diffPatch).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(result.current.getPatchState(PATH).status).toBe("loading");
    });

    act(() => {
      removeEnvironmentDiffPatchQueries({
        environmentId: ENVIRONMENT_ID,
        queryClient,
      });
    });

    act(() => {
      result.current.requestPaths({ visible: [PATH], overscan: [] });
    });
    await waitFor(() => {
      expect(sdk.environments.diffPatch).toHaveBeenCalledTimes(2);
    });
    await waitFor(() => {
      const state = result.current.getPatchState(PATH);
      expect(state.status).toBe("loaded");
      expect(state.patch).toBe(freshPatch.patch);
    });

    await act(async () => {
      firstFetch.resolve(availableResponse(stalePatch));
      await firstFetch.promise;
    });

    expect(result.current.getPatchState(PATH)).toMatchObject({
      status: "loaded",
      patch: freshPatch.patch,
    });
    expect(queryClient.getQueryData<DiffPatchEntry>(patchKey())).toEqual(
      freshPatch,
    );
  });

  it("drops a fetch resolving after an all-environment (reconnect) eviction, even for a never-individually-evicted env", async () => {
    const { wrapper, queryClient } = createQueryClientTestHarness();

    const RECONNECT_ENV = "env-reconnect-only";
    const reconnectKey = environmentDiffPatchQueryKey(
      RECONNECT_ENV,
      "all",
      "main",
      PATH,
    );

    const stalePatch: DiffPatchEntry = {
      path: PATH,
      patch: "diff --git a/file.ts b/file.ts\n+stale\n",
      truncated: false,
    };
    const freshPatch: DiffPatchEntry = {
      path: PATH,
      patch: "diff --git a/file.ts b/file.ts\n+fresh\n",
      truncated: false,
    };

    const firstFetch = createDeferredPromise<EnvironmentDiffPatchResponse>();
    vi.mocked(sdk.environments.diffPatch)
      .mockReturnValueOnce(firstFetch.promise)
      .mockResolvedValueOnce(availableResponse(freshPatch));

    const { result } = renderHook(
      () => useEnvironmentDiffPatches(RECONNECT_ENV, { target: TARGET }),
      { wrapper },
    );

    act(() => {
      result.current.requestPaths({ visible: [PATH], overscan: [] });
    });
    await waitFor(() => {
      expect(sdk.environments.diffPatch).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(result.current.getPatchState(PATH).status).toBe("loading");
    });

    act(() => {
      bumpAllDiffPatchEvictionGenerations();
    });

    await act(async () => {
      firstFetch.resolve(availableResponse(stalePatch));
      await firstFetch.promise;
    });

    await waitFor(() => {
      expect(result.current.getPatchState(PATH).status).toBe("idle");
    });
    expect(queryClient.getQueryData(reconnectKey)).toBeUndefined();

    act(() => {
      result.current.requestPaths({ visible: [PATH], overscan: [] });
    });
    await waitFor(() => {
      expect(sdk.environments.diffPatch).toHaveBeenCalledTimes(2);
    });
    await waitFor(() => {
      const state = result.current.getPatchState(PATH);
      expect(state.status).toBe("loaded");
      expect(state.patch).toBe(freshPatch.patch);
    });
  });

  it("caches a patch fetch that resolves with no intervening eviction", async () => {
    const { wrapper, queryClient } = createQueryClientTestHarness();

    const patch: DiffPatchEntry = {
      path: PATH,
      patch: "diff --git a/file.ts b/file.ts\n+content\n",
      truncated: false,
    };
    vi.mocked(sdk.environments.diffPatch).mockResolvedValue(
      availableResponse(patch),
    );

    const { result } = renderHook(
      () => useEnvironmentDiffPatches(ENVIRONMENT_ID, { target: TARGET }),
      { wrapper },
    );

    act(() => {
      result.current.requestPaths({ visible: [PATH], overscan: [] });
    });

    await waitFor(() => {
      const state = result.current.getPatchState(PATH);
      expect(state.status).toBe("loaded");
      expect(state.patch).toBe(patch.patch);
    });
    expect(queryClient.getQueryData<DiffPatchEntry>(patchKey())).toEqual(patch);
  });
});

describe("useEnvironmentDiffPatches cache retention", () => {
  it("keeps patches while a reader is mounted and evicts them one minute after the last reader leaves", () => {
    vi.useFakeTimers();
    try {
      const { wrapper, queryClient } = createQueryClientTestHarness();
      const patch: DiffPatchEntry = {
        path: PATH,
        patch: "diff --git a/file.ts b/file.ts\n+kept\n",
        truncated: false,
      };

      const first = renderHook(
        () => useEnvironmentDiffPatches(ENVIRONMENT_ID, { target: TARGET }),
        { wrapper },
      );
      act(() => {
        first.result.current.seedInitialPatches([patch]);
      });
      expect(queryClient.getQueryData(patchKey())).toEqual(patch);

      act(() => {
        vi.advanceTimersByTime(HEAVY_PAYLOAD_GC_TIME_MS * 10);
      });
      expect(queryClient.getQueryData(patchKey())).toEqual(patch);

      const second = renderHook(
        () => useEnvironmentDiffPatches(ENVIRONMENT_ID, { target: TARGET }),
        { wrapper },
      );
      first.unmount();
      act(() => {
        vi.advanceTimersByTime(HEAVY_PAYLOAD_GC_TIME_MS * 2);
      });
      expect(queryClient.getQueryData(patchKey())).toEqual(patch);

      second.unmount();
      act(() => {
        vi.advanceTimersByTime(HEAVY_PAYLOAD_GC_TIME_MS - 1);
      });
      expect(queryClient.getQueryData(patchKey())).toEqual(patch);

      const third = renderHook(
        () => useEnvironmentDiffPatches(ENVIRONMENT_ID, { target: TARGET }),
        { wrapper },
      );
      act(() => {
        vi.advanceTimersByTime(HEAVY_PAYLOAD_GC_TIME_MS * 2);
      });
      expect(queryClient.getQueryData(patchKey())).toEqual(patch);

      third.unmount();
      act(() => {
        vi.advanceTimersByTime(HEAVY_PAYLOAD_GC_TIME_MS);
      });
      expect(queryClient.getQueryData(patchKey())).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});
