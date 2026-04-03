// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import type { Environment, PromptInput, Thread, WorkspaceStatus } from "@bb/domain";
import type { EnvironmentActionResponse } from "@bb/server-contract";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ThreadGitActionDialogError } from "@/components/thread/ThreadGitActionDialog";
import { HttpError } from "@/lib/api";
import {
  buildCommitFailureFollowUpInstruction,
  buildSquashMergeConflictFollowUpInstruction,
} from "@/lib/thread-operation-prompts";
import type {
  RequestEnvironmentActionMutationLike,
  SendMessageMutationLike,
} from "./threadDetailMutationTypes";
import { useThreadGitActions } from "./useThreadGitActions";

interface ThreadOverrides extends Partial<Thread> {}

interface EnvironmentOverrides extends Partial<Environment> {}

interface WorkspaceStatusOptions {
  hasCommittedUnmergedChanges?: boolean;
  hasUncommittedChanges?: boolean;
}

interface RequestEnvironmentActionMutationOptions {
  isPending?: boolean;
  mutateAsync?: RequestEnvironmentActionMutationLike["mutateAsync"];
}

interface SendMessageMutationOptions {
  isPending?: boolean;
  mutateAsync?: SendMessageMutationLike["mutateAsync"];
}

function makeThread(overrides: ThreadOverrides = {}): Thread {
  return {
    archivedAt: null,
    createdAt: 1,
    deletedAt: null,
    environmentId: "environment-1",
    id: "thread-1",
    lastReadAt: null,
    parentThreadId: null,
    projectId: "project-1",
    providerId: "provider-1",
    stopRequestedAt: null,
    status: "idle",
    title: "Thread title",
    titleFallback: "Thread title",
    type: "standard",
    updatedAt: 10,
    ...overrides,
  };
}

function makeEnvironment(overrides: EnvironmentOverrides = {}): Environment {
  return {
    branchName: "feature/test",
    createdAt: 1,
    defaultBranch: "main",
    hostId: "host-1",
    id: "environment-1",
    isGitRepo: true,
    isWorktree: true,
    managed: false,
    mergeBaseBranch: "main",
    path: "/tmp/worktree",
    projectId: "project-1",
    status: "ready",
    updatedAt: 1,
    workspaceProvisionType: "managed-worktree",
    ...overrides,
  };
}

function makeWorkspaceStatus(
  options: WorkspaceStatusOptions = {},
): WorkspaceStatus {
  return {
    branch: {
      currentBranch: "feature/test",
      defaultBranch: "main",
    },
    mergeBase: {
      aheadCount: 1,
      baseRef: "origin/main",
      behindCount: 0,
      commits: [],
      hasCommittedUnmergedChanges: options.hasCommittedUnmergedChanges ?? false,
      mergeBaseBranch: "main",
    },
    workingTree: {
      changedFiles: 1,
      deletions: 0,
      files: [],
      hasUncommittedChanges: options.hasUncommittedChanges ?? false,
      insertions: 1,
      state: options.hasUncommittedChanges ? "dirty_uncommitted" : "clean",
    },
  };
}

function makeCommitActionResponse(): EnvironmentActionResponse {
  return {
    action: "commit",
    commitSha: "abc123",
    commitSubject: "Commit subject",
    message: "Committed changes",
    ok: true,
  };
}

function createRequestEnvironmentActionMutation(
  options: RequestEnvironmentActionMutationOptions = {},
): RequestEnvironmentActionMutationLike {
  return {
    isPending: options.isPending ?? false,
    mutateAsync:
      options.mutateAsync ??
      vi.fn(async () => makeCommitActionResponse()),
  };
}

function createSendMessageMutation(
  options: SendMessageMutationOptions = {},
): SendMessageMutationLike {
  return {
    isPending: options.isPending ?? false,
    mutateAsync:
      options.mutateAsync ??
      vi.fn(async () => undefined),
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("useThreadGitActions", () => {
  it("shows a commit action for direct thread environments with uncommitted changes", () => {
    const { result } = renderHook(() =>
      useThreadGitActions({
        environment: makeEnvironment({
          managed: false,
        }),
        requestEnvironmentAction: createRequestEnvironmentActionMutation(),
        sendMessage: createSendMessageMutation(),
        thread: makeThread(),
        workspaceStatus: makeWorkspaceStatus({
          hasUncommittedChanges: true,
        }),
      }),
    );

    expect(result.current.threadHeaderGitAction).toEqual({
      label: "Commit",
      target: {
        kind: "commit",
      },
    });
  });

  it("shows squash merge for managed environments with committed changes", () => {
    const { result } = renderHook(() =>
      useThreadGitActions({
        environment: makeEnvironment({
          managed: true,
        }),
        requestEnvironmentAction: createRequestEnvironmentActionMutation(),
        sendMessage: createSendMessageMutation(),
        thread: makeThread(),
        workspaceStatus: makeWorkspaceStatus({
          hasCommittedUnmergedChanges: true,
          hasUncommittedChanges: false,
        }),
      }),
    );

    expect(result.current.threadHeaderGitAction).toEqual({
      label: "Squash merge",
      target: {
        kind: "squash_merge",
      },
    });
  });

  it("forwards commit requests to the environment mutation", async () => {
    const requestEnvironmentAction = createRequestEnvironmentActionMutation();
    const thread = makeThread({
      environmentId: "environment-commit",
    });
    const { result } = renderHook(() =>
      useThreadGitActions({
        environment: makeEnvironment(),
        requestEnvironmentAction,
        sendMessage: createSendMessageMutation(),
        thread,
        workspaceStatus: makeWorkspaceStatus(),
      }),
    );

    await act(async () => {
      await result.current.handleCommitThread();
    });

    expect(requestEnvironmentAction.mutateAsync).toHaveBeenCalledWith({
      action: "commit",
      id: "environment-commit",
    });
  });

  it("maps squash-merge conflicts into a dialog error with ask-agent guidance", async () => {
    const thread = makeThread({
      environmentId: "environment-merge",
    });
    const mergeBaseBranch = "main";
    const conflictError = new HttpError({
      body: {
        details: {
          conflictFiles: ["src/thread.ts"],
          kind: "squash_merge_conflict",
        },
      },
      message: "Squash merge failed",
      status: 409,
    });
    const requestEnvironmentAction = createRequestEnvironmentActionMutation({
      mutateAsync: vi.fn(async () => {
        throw conflictError;
      }),
    });
    const { result } = renderHook(() =>
      useThreadGitActions({
        environment: makeEnvironment({
          managed: true,
        }),
        requestEnvironmentAction,
        sendMessage: createSendMessageMutation(),
        thread,
        workspaceStatus: makeWorkspaceStatus({
          hasCommittedUnmergedChanges: true,
        }),
      }),
    );

    let thrownError: unknown;

    await act(async () => {
      try {
        await result.current.handleSquashMergeThread({
          mergeBaseBranch,
        });
      } catch (error) {
        thrownError = error;
      }
    });

    expect(thrownError).toBeInstanceOf(ThreadGitActionDialogError);

    if (!(thrownError instanceof ThreadGitActionDialogError)) {
      throw new Error("Expected a ThreadGitActionDialogError");
    }

    expect(thrownError.message).toBe("HTTP 409: Squash merge failed");
    expect(thrownError.askAgentInput).toEqual([
      {
        text: buildSquashMergeConflictFollowUpInstruction(
          {
            action: "squash_merge",
            options: {
              mergeBaseBranch,
            },
          },
          {
            conflictFiles: ["src/thread.ts"],
          },
        ),
        type: "text",
      },
    ]);
  });

  it("maps commit failures into ask-agent instructions", async () => {
    const thread = makeThread({
      environmentId: "environment-commit-failure",
    });
    const commitError = new HttpError({
      body: {
        details: {
          errorMessage: "Git commit exited with status 1",
          kind: "commit_failed",
        },
      },
      message: "Commit failed",
      status: 409,
    });
    const requestEnvironmentAction = createRequestEnvironmentActionMutation({
      mutateAsync: vi.fn(async () => {
        throw commitError;
      }),
    });
    const { result } = renderHook(() =>
      useThreadGitActions({
        environment: makeEnvironment(),
        requestEnvironmentAction,
        sendMessage: createSendMessageMutation(),
        thread,
        workspaceStatus: makeWorkspaceStatus({
          hasUncommittedChanges: true,
        }),
      }),
    );

    let thrownError: unknown;

    await act(async () => {
      try {
        await result.current.handleCommitThread();
      } catch (error) {
        thrownError = error;
      }
    });

    expect(thrownError).toBeInstanceOf(ThreadGitActionDialogError);

    if (!(thrownError instanceof ThreadGitActionDialogError)) {
      throw new Error("Expected a ThreadGitActionDialogError");
    }

    expect(thrownError.askAgentInput).toEqual([
      {
        text: buildCommitFailureFollowUpInstruction({
          errorMessage: "Git commit exited with status 1",
        }),
        type: "text",
      },
    ]);
  });

  it("sends ask-agent follow-up messages through the thread mutation", async () => {
    const input: PromptInput[] = [
      {
        text: "Resolve the merge conflict and continue.",
        type: "text",
      },
    ];
    const sendMessage = createSendMessageMutation();
    const thread = makeThread({
      id: "thread-follow-up",
    });
    const { result } = renderHook(() =>
      useThreadGitActions({
        environment: makeEnvironment(),
        requestEnvironmentAction: createRequestEnvironmentActionMutation(),
        sendMessage,
        thread,
        workspaceStatus: makeWorkspaceStatus(),
      }),
    );

    await act(async () => {
      await result.current.handleAskAgentToFixGitAction(input);
    });

    expect(sendMessage.mutateAsync).toHaveBeenCalledWith({
      id: thread.id,
      input,
      mode: "auto",
    });
  });
});
