// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { Environment, Project, Thread } from "@bb/domain";
import type {
  EnvironmentActionResponse,
  EnvironmentPromotionResponse,
  ProjectResponse,
} from "@bb/server-contract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import { useHostDaemon } from "@/hooks/useHostDaemon";
import * as api from "@/lib/api";
import type { RequestEnvironmentActionMutationLike } from "./threadDetailMutationTypes";
import { useThreadEnvironmentPromotionActions } from "./useThreadEnvironmentPromotionActions";

interface ThreadOverrides extends Partial<Thread> {}

interface EnvironmentOverrides extends Partial<Environment> {}

type HostDaemonSnapshot = ReturnType<typeof useHostDaemon>;

vi.mock("@/hooks/useHostDaemon", () => ({
  useHostDaemon: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  getEnvironmentPromotion: vi.fn(),
  listProjects: vi.fn(),
}));

function makeThread(overrides: ThreadOverrides = {}): Thread {
  return {
    archivedAt: null,
    automationId: null,
    createdAt: 1,
    deletedAt: null,
    environmentId: "env-1",
    id: "thr-1",
    lastReadAt: null,
    latestAttentionAt: 2,
    parentThreadId: null,
    projectId: "proj-1",
    providerId: "codex",
    status: "idle",
    stopRequestedAt: null,
    title: "Thread",
    titleFallback: "Thread",
    type: "standard",
    updatedAt: 2,
    ...overrides,
  };
}

function makeEnvironment(overrides: EnvironmentOverrides = {}): Environment {
  return {
    branchName: "bb/thread",
    cleanupMode: null,
    cleanupRequestedAt: null,
    createdAt: 1,
    defaultBranch: "main",
    hostId: "host-local",
    id: "env-1",
    isGitRepo: true,
    isWorktree: true,
    managed: true,
    mergeBaseBranch: "main",
    path: "/tmp/project/.bb-worktrees/thread",
    projectId: "proj-1",
    status: "ready",
    updatedAt: 2,
    workspaceProvisionType: "managed-worktree",
    ...overrides,
  };
}

function makeProjectResponse(): ProjectResponse {
  const project: Project = {
    createdAt: 1,
    id: "proj-1",
    name: "Project",
    updatedAt: 2,
  };
  return {
    ...project,
    sources: [
      {
        createdAt: 1,
        hostId: "host-local",
        id: "src-1",
        isDefault: true,
        path: "/tmp/project",
        projectId: project.id,
        type: "local_path",
        updatedAt: 2,
      },
    ],
  };
}

function makePromotionResponse(
  isPromoted: boolean,
): EnvironmentPromotionResponse {
  return {
    state: {
      isPromoted,
      branchName: "bb/thread",
    },
    actions: {
      promote: {
        enabled: !isPromoted,
        unavailableReason: isPromoted ? "already_promoted" : null,
      },
      demote: {
        enabled: isPromoted,
        unavailableReason: isPromoted ? null : "not_promoted",
      },
    },
  };
}

function makeHostDaemonSnapshot(): HostDaemonSnapshot {
  return {
    connectedPersistentHost: null,
    hasConnectedPersistentHost: true,
    hasDaemon: true,
    isLocalHost: (hostId) => hostId === "host-local",
    localHost: null,
    localHostId: "host-local",
    pickFolder: null,
    platform: null,
    supportsNativeFolderPicker: false,
  };
}

function makeRequestEnvironmentAction(): RequestEnvironmentActionMutationLike {
  return {
    isPending: false,
    mutateAsync: vi.fn(
      async (): Promise<EnvironmentActionResponse> => ({
        action: "promote",
        message: "Promoted",
        ok: true,
      }),
    ),
  };
}

beforeEach(() => {
  vi.mocked(useHostDaemon).mockReturnValue(makeHostDaemonSnapshot());
  vi.mocked(api.listProjects).mockResolvedValue([makeProjectResponse()]);
  vi.mocked(api.getEnvironmentPromotion).mockResolvedValue(
    makePromotionResponse(false),
  );
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("useThreadEnvironmentPromotionActions", () => {
  it("enables promote for a clean local worktree environment", async () => {
    const requestEnvironmentAction = makeRequestEnvironmentAction();
    const { wrapper } = createQueryClientTestHarness();
    const { result } = renderHook(
      () =>
        useThreadEnvironmentPromotionActions({
          environment: makeEnvironment(),
          requestEnvironmentAction,
          thread: makeThread(),
        }),
      { wrapper },
    );

    await waitFor(() => {
      expect(result.current.headerAction).toMatchObject({
        disabled: false,
        label: "Promote",
        target: { kind: "promote" },
      });
    });

    await act(async () => {
      await result.current.handlePromotionAction({ kind: "promote" });
    });

    expect(requestEnvironmentAction.mutateAsync).toHaveBeenCalledWith({
      action: "promote",
      id: "env-1",
    });
  });

  it("disables promotion for a different host before querying promotion state", () => {
    const { wrapper } = createQueryClientTestHarness();
    const { result } = renderHook(
      () =>
        useThreadEnvironmentPromotionActions({
          environment: makeEnvironment({ hostId: "host-other" }),
          requestEnvironmentAction: makeRequestEnvironmentAction(),
          thread: makeThread(),
        }),
      { wrapper },
    );

    expect(api.getEnvironmentPromotion).not.toHaveBeenCalled();
    expect(result.current.headerAction).toMatchObject({
      disabled: true,
      label: "Promote",
      title:
        "Promotion is only available for local worktree environments on this host.",
    });
  });

  it("maps server promotion unavailable reasons to header copy", async () => {
    vi.mocked(api.getEnvironmentPromotion).mockResolvedValue({
      state: {
        isPromoted: false,
        branchName: "bb/thread",
      },
      actions: {
        promote: {
          enabled: false,
          unavailableReason: "primary_checkout_dirty",
        },
        demote: {
          enabled: false,
          unavailableReason: "not_promoted",
        },
      },
    });
    const { wrapper } = createQueryClientTestHarness();
    const { result } = renderHook(
      () =>
        useThreadEnvironmentPromotionActions({
          environment: makeEnvironment(),
          requestEnvironmentAction: makeRequestEnvironmentAction(),
          thread: makeThread(),
        }),
      { wrapper },
    );

    await waitFor(() => {
      expect(result.current.headerAction).toMatchObject({
        disabled: true,
        label: "Promote",
        title: "Clean the primary checkout before continuing.",
      });
    });
  });
});
