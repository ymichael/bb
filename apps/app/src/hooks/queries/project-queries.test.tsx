// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ProjectBranchesResponse } from "@bb/server-contract";
import { readProjectBranchOptions } from "@/lib/project-branch-options";
import { sdk } from "@/lib/sdk";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useProjectSourceBranches } from "./project-queries";
import { projectSourceBranchesQueryKeyPrefix } from "./query-keys";

vi.mock("@/lib/sdk", () => ({
  sdk: { projects: { branches: vi.fn() } },
}));

vi.mock("@/lib/project-branch-options", () => ({
  readProjectBranchOptions: vi.fn(),
}));

vi.mock("@/hooks/useRealtimeSubscription", () => ({
  useProjectDetailRealtimeSubscription: vi.fn(),
}));

const INITIAL_BRANCHES = {
  branches: ["main"],
  branchesTruncated: false,
  checkout: { kind: "branch", branchName: "main", headSha: null },
  defaultBranch: "main",
  defaultBranchRelation: "equal",
  defaultWorktreeBaseBranch: null,
  hasUncommittedChanges: false,
  operation: { kind: "none" },
  originDefaultBranch: "origin/main",
  remoteBranches: [],
  remoteBranchesTruncated: false,
  selectedBranch: null,
} satisfies ProjectBranchesResponse;

describe("useProjectSourceBranches", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("starts with cached branch options and refreshes through the blocking SDK operation", async () => {
    const { wrapper, queryClient } = createQueryClientTestHarness();
    vi.mocked(readProjectBranchOptions).mockResolvedValueOnce(INITIAL_BRANCHES);
    vi.mocked(sdk.projects.branches).mockResolvedValueOnce({
      ...INITIAL_BRANCHES,
      remoteBranches: ["origin/main", "origin/new"],
    });

    const { result } = renderHook(
      () => useProjectSourceBranches("project-1", "host-1"),
      { wrapper },
    );
    await waitFor(() => {
      expect(readProjectBranchOptions).toHaveBeenCalledTimes(1);
    });
    expect(readProjectBranchOptions).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        hostId: "host-1",
        limit: "50",
        projectId: "project-1",
      }),
    );
    expect(sdk.projects.branches).not.toHaveBeenCalled();

    await act(async () => {
      await result.current.refreshFromRemote();
    });
    await waitFor(() => {
      expect(result.current.data?.remoteBranches).toEqual([
        "origin/main",
        "origin/new",
      ]);
    });
    expect(sdk.projects.branches).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        hostId: "host-1",
        limit: "50",
        projectId: "project-1",
      }),
    );
    expect(vi.mocked(sdk.projects.branches).mock.calls[0]?.[0]).toHaveProperty(
      "signal",
    );

    const [query] = queryClient.getQueryCache().findAll({
      queryKey: projectSourceBranchesQueryKeyPrefix("project-1"),
    });
    expect(query?.options).toEqual(
      expect.objectContaining({
        refetchOnWindowFocus: false,
        staleTime: 30_000,
      }),
    );
  });

  it("reports fetching while the blocking read waits, then reverts to cached reads", async () => {
    const { wrapper } = createQueryClientTestHarness();
    let releaseBlocking: ((value: ProjectBranchesResponse) => void) | undefined;
    vi.mocked(readProjectBranchOptions)
      .mockResolvedValueOnce(INITIAL_BRANCHES)
      .mockResolvedValueOnce(INITIAL_BRANCHES);
    vi.mocked(sdk.projects.branches).mockImplementationOnce(
      () =>
        new Promise<ProjectBranchesResponse>((resolve) => {
          releaseBlocking = resolve;
        }),
    );

    const { result } = renderHook(
      () => useProjectSourceBranches("project-1", "host-1"),
      { wrapper },
    );
    await waitFor(() => {
      expect(result.current.isFetching).toBe(false);
    });

    let refreshed: Promise<void> | undefined;
    act(() => {
      refreshed = result.current.refreshFromRemote();
    });
    await waitFor(() => {
      expect(result.current.isFetching).toBe(true);
    });

    await act(async () => {
      releaseBlocking?.(INITIAL_BRANCHES);
      await refreshed;
    });
    await waitFor(() => {
      expect(result.current.isFetching).toBe(false);
    });

    await act(async () => {
      await result.current.refetch();
    });
    expect(readProjectBranchOptions).toHaveBeenCalledTimes(2);
  });

  it("still reaches the daemon when the picker opens during the initial cached fetch", async () => {
    const { wrapper } = createQueryClientTestHarness();
    let releaseInitial: ((value: ProjectBranchesResponse) => void) | undefined;
    vi.mocked(readProjectBranchOptions)
      .mockImplementationOnce(
        () =>
          new Promise<ProjectBranchesResponse>((resolve) => {
            releaseInitial = resolve;
          }),
      )
      .mockResolvedValueOnce(INITIAL_BRANCHES);
    vi.mocked(sdk.projects.branches).mockResolvedValueOnce({
      ...INITIAL_BRANCHES,
      remoteBranches: ["origin/main", "origin/new"],
    });

    const { result } = renderHook(
      () => useProjectSourceBranches("project-1", "host-1"),
      { wrapper },
    );
    await waitFor(() => {
      expect(readProjectBranchOptions).toHaveBeenCalledTimes(1);
    });

    let refreshed: Promise<void> | undefined;
    act(() => {
      refreshed = result.current.refreshFromRemote();
    });
    await act(async () => {
      releaseInitial?.(INITIAL_BRANCHES);
      await refreshed;
    });

    await waitFor(() => {
      expect(sdk.projects.branches).toHaveBeenCalledTimes(1);
    });
    expect(sdk.projects.branches).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ projectId: "project-1" }),
    );
    await waitFor(() => {
      expect(result.current.data?.remoteBranches).toEqual([
        "origin/main",
        "origin/new",
      ]);
    });

    await act(async () => {
      await result.current.refetch();
    });
    expect(readProjectBranchOptions).toHaveBeenCalledTimes(2);
  });

  it("keeps every retry of a blocking read on the public operation", async () => {
    const { wrapper } = createQueryClientTestHarness({
      queries: { retry: 1, retryDelay: 0 },
    });
    vi.mocked(readProjectBranchOptions).mockResolvedValueOnce(INITIAL_BRANCHES);
    vi.mocked(sdk.projects.branches)
      .mockRejectedValueOnce(new Error("Failed to fetch"))
      .mockResolvedValueOnce({
        ...INITIAL_BRANCHES,
        remoteBranches: ["origin/new"],
      });

    const { result } = renderHook(
      () => useProjectSourceBranches("project-1", "host-1"),
      { wrapper },
    );
    await waitFor(() => {
      expect(readProjectBranchOptions).toHaveBeenCalledTimes(1);
    });

    await act(async () => {
      await result.current.refreshFromRemote();
    });

    await waitFor(() => {
      expect(sdk.projects.branches).toHaveBeenCalledTimes(2);
    });
    expect(sdk.projects.branches).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ projectId: "project-1" }),
    );
    expect(sdk.projects.branches).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ projectId: "project-1" }),
    );
  });
});
