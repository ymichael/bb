// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ProjectBranchesResponse } from "@bb/server-contract";
import { readProjectBranchOptions } from "@/lib/project-branch-options";
import { sdk } from "@/lib/sdk";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import { afterEach, describe, expect, it, vi } from "vitest";
import { usePluginBranches } from "./usePluginBranchPickerState";

vi.mock("@/lib/sdk", () => ({
  sdk: { projects: { branches: vi.fn() } },
}));

vi.mock("@/lib/project-branch-options", () => ({
  readProjectBranchOptions: vi.fn(),
}));

vi.mock("@/hooks/useRealtimeSubscription", () => ({
  useProjectDetailRealtimeSubscription: vi.fn(),
}));

const BRANCHES = {
  branches: ["release"],
  branchesTruncated: false,
  checkout: { kind: "branch", branchName: "main", headSha: null },
  defaultBranch: "main",
  defaultBranchRelation: "equal",
  defaultWorktreeBaseBranch: null,
  isWorktree: false,
  hasUncommittedChanges: false,
  operation: { kind: "none" },
  originDefaultBranch: "origin/main",
  remoteBranches: [],
  remoteBranchesTruncated: false,
  selectedBranch: null,
} satisfies ProjectBranchesResponse;

describe("usePluginBranches", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("searches cached branches and refreshes them from the host", async () => {
    const { wrapper } = createQueryClientTestHarness();
    vi.mocked(readProjectBranchOptions).mockResolvedValueOnce(BRANCHES);
    vi.mocked(sdk.projects.branches).mockResolvedValueOnce({
      ...BRANCHES,
      remoteBranches: ["origin/release"],
    });

    const { result } = renderHook(
      () =>
        usePluginBranches({
          hostId: "host-1",
          projectId: "project-1",
          query: "release",
        }),
      { wrapper },
    );

    await waitFor(() => {
      expect(result.current.branches).toEqual(["release"]);
    });
    expect(readProjectBranchOptions).toHaveBeenCalledWith(
      expect.objectContaining({
        hostId: "host-1",
        projectId: "project-1",
        query: "release",
      }),
    );

    await act(async () => {
      await result.current.refresh();
    });

    await waitFor(() => {
      expect(result.current.remoteBranches).toEqual(["origin/release"]);
    });
    expect(sdk.projects.branches).toHaveBeenCalledWith(
      expect.objectContaining({
        hostId: "host-1",
        projectId: "project-1",
        query: "release",
      }),
    );
  });
});
