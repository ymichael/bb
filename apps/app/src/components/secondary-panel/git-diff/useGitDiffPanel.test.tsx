// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Environment } from "@bb/domain";
import { StrictMode, useState, type ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useUpdateEnvironment } from "@/hooks/mutations/environment-mutations";
import { makeEnvironment } from "@bb/test-helpers/domain-fixtures";
import { useEnvironmentMergeBase } from "./useEnvironmentMergeBase";
import { useGitDiffPanel } from "./useGitDiffPanel";
import { useGitDiffPanelState } from "./useGitDiffPanelState";

interface MergeBaseBranchRequest {
  environmentId: string;
  selectedBranch?: string;
}

const mergeBaseBranchRequests = vi.hoisted((): MergeBaseBranchRequest[] => []);

vi.mock("../../../hooks/queries/environment-queries", () => ({
  useEnvironmentMergeBaseBranches: (
    environmentId: string,
    options?: { selectedBranch?: string },
  ) => {
    mergeBaseBranchRequests.push({
      environmentId,
      selectedBranch: options?.selectedBranch,
    });
    return { data: undefined, isFetching: false };
  },
  useEnvironmentWorkStatus: () => ({
    data: {
      outcome: "available",
      workspace: {
        mergeBase: {
          commits: [
            { sha: "sha-left", shortSha: "sha-lef", subject: "Left commit" },
            {
              sha: "sha-right",
              shortSha: "sha-rig",
              subject: "Right commit",
            },
          ],
        },
        workingTree: { files: [] },
      },
    },
  }),
}));

const noop = () => undefined;

function makeMergeBaseEnvironment(
  id: string,
  mergeBaseBranch: string,
): Environment {
  return makeEnvironment({
    baseBranch: null,
    branchName: `bb/${id}`,
    createdAt: 1,
    hostId: "host-1",
    id,
    mergeBaseBranch,
    path: `/tmp/${id}`,
    projectId: "project-1",
    updatedAt: 1,
  });
}

function TestRoot({ children }: { children: ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          mutations: { retry: false },
          queries: { retry: false },
        },
      }),
  );
  return (
    <StrictMode>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </StrictMode>
  );
}

function useMergeBaseOwner(environment: Environment, threadId: string) {
  const updateEnvironment = useUpdateEnvironment();
  const panel = useGitDiffPanel({
    activeSecondaryTab: null,
    clearActiveFileTabs: noop,
    defaultMergeBaseBranch:
      environment.mergeBaseBranch ?? environment.defaultBranch ?? undefined,
    environmentId: environment.id,
    mergeBaseBranchOptionsEnabled: true,
    setThreadSecondaryPanel: noop,
    threadId,
  });
  const { effectiveMergeBaseBranch } = useEnvironmentMergeBase({
    environment,
    selectedMergeBaseBranch: panel.selectedMergeBaseBranch,
    setSelectedMergeBaseBranch: panel.setSelectedMergeBaseBranch,
    updateEnvironment,
  });
  const diffState = useGitDiffPanelState({
    environmentId: environment.id,
    isDiffPanelActive: true,
    onClearPendingGitDiffIntent: panel.clearPendingGitDiffIntent,
    pendingGitDiffCommitSha: panel.pendingGitDiffCommitSha,
    pendingGitDiffScrollPath: panel.pendingGitDiffScrollPath,
    requestedMergeBaseBranch: effectiveMergeBaseBranch,
  });
  return { ...diffState, ...panel, effectiveMergeBaseBranch };
}

beforeEach(() => {
  mergeBaseBranchRequests.length = 0;
});

afterEach(cleanup);

it("keeps production merge-base owners independent through close and reopen", async () => {
  const leftEnvironment = makeMergeBaseEnvironment("env-left", "main");
  const rightEnvironment = makeMergeBaseEnvironment("env-right", "release");
  const left = renderHook(() => useMergeBaseOwner(leftEnvironment, "left"), {
    wrapper: TestRoot,
  });
  const right = renderHook(() => useMergeBaseOwner(rightEnvironment, "right"), {
    wrapper: TestRoot,
  });

  await waitFor(() => {
    expect(left.result.current.effectiveMergeBaseBranch).toBe("main");
    expect(right.result.current.effectiveMergeBaseBranch).toBe("release");
  });

  right.unmount();
  expect(left.result.current.effectiveMergeBaseBranch).toBe("main");

  const reopenedRight = renderHook(
    () => useMergeBaseOwner(rightEnvironment, "right"),
    { wrapper: TestRoot },
  );
  await waitFor(() => {
    expect(left.result.current.effectiveMergeBaseBranch).toBe("main");
    expect(reopenedRight.result.current.effectiveMergeBaseBranch).toBe(
      "release",
    );
  });

  expect(
    mergeBaseBranchRequests
      .filter(({ environmentId }) => environmentId === "env-left")
      .every(({ selectedBranch }) => selectedBranch === "main"),
  ).toBe(true);
  expect(
    mergeBaseBranchRequests
      .filter(({ environmentId }) => environmentId === "env-right")
      .every(({ selectedBranch }) => selectedBranch === "release"),
  ).toBe(true);
});

it("never queries a new environment with the previous environment branch", async () => {
  const environmentA = makeMergeBaseEnvironment("env-a", "branch-a");
  const environmentB = makeMergeBaseEnvironment("env-b", "branch-b");
  const owner = renderHook(
    ({ environment }) => useMergeBaseOwner(environment, "switching"),
    { initialProps: { environment: environmentA }, wrapper: TestRoot },
  );
  await waitFor(() =>
    expect(owner.result.current.effectiveMergeBaseBranch).toBe("branch-a"),
  );

  mergeBaseBranchRequests.length = 0;
  owner.rerender({ environment: environmentB });

  await waitFor(() =>
    expect(owner.result.current.effectiveMergeBaseBranch).toBe("branch-b"),
  );
  const environmentBRequests = mergeBaseBranchRequests.filter(
    ({ environmentId }) => environmentId === "env-b",
  );
  expect(environmentBRequests.length).toBeGreaterThan(0);
  expect(
    environmentBRequests.every(
      ({ selectedBranch }) => selectedBranch === "branch-b",
    ),
  ).toBe(true);
});

it("does not revive an unconsumed file intent after navigating away and back", () => {
  const environmentA = makeMergeBaseEnvironment("env-a", "branch-a");
  const environmentB = makeMergeBaseEnvironment("env-b", "branch-b");
  const owner = renderHook(
    ({ environment, threadId }) => useMergeBaseOwner(environment, threadId),
    {
      initialProps: { environment: environmentA, threadId: "thread-a" },
      wrapper: TestRoot,
    },
  );

  act(() => owner.result.current.openDiffFile("left.ts"));
  expect(owner.result.current.pendingGitDiffScrollPath).toBe("left.ts");

  owner.rerender({ environment: environmentB, threadId: "thread-b" });
  expect(owner.result.current.pendingGitDiffScrollPath).toBeNull();

  owner.rerender({ environment: environmentA, threadId: "thread-a" });
  expect(owner.result.current.pendingGitDiffScrollPath).toBeNull();
});

it("keeps delayed file and commit intents with the owner that requested them", async () => {
  const left = renderHook(
    () =>
      useMergeBaseOwner(makeMergeBaseEnvironment("env-left", "main"), "left"),
    { wrapper: TestRoot },
  );
  const right = renderHook(
    () =>
      useMergeBaseOwner(
        makeMergeBaseEnvironment("env-right", "release"),
        "right",
      ),
    { wrapper: TestRoot },
  );

  act(() => left.result.current.openDiffFile("left.ts"));
  expect(left.result.current.pendingGitDiffScrollPath).toBe("left.ts");
  expect(right.result.current.pendingGitDiffScrollPath).toBeNull();

  act(() => right.result.current.clearPendingGitDiffIntent());
  expect(left.result.current.pendingGitDiffScrollPath).toBe("left.ts");

  act(() => left.result.current.clearPendingGitDiffIntent());
  expect(left.result.current.pendingGitDiffScrollPath).toBeNull();

  act(() => left.result.current.openCommitDiff("sha-left"));
  await waitFor(() => {
    expect(left.result.current.gitDiffSelectValue).toBe("sha-left");
    expect(left.result.current.pendingGitDiffCommitSha).toBeNull();
  });
  expect(right.result.current.gitDiffSelectValue).toBe("all");
  expect(right.result.current.pendingGitDiffCommitSha).toBeNull();
});
