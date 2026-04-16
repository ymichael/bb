// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Thread } from "@bb/domain";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import {
  allAvailableModelsQueryKeyPrefix,
  allHostQueryKeyPrefix,
  threadPendingInteractionsQueryKey,
  environmentGitDiffQueryKey,
  environmentGitDiffQueryKeyPrefix,
  environmentMergeBaseBranchesQueryKey,
  environmentMergeBaseBranchesQueryKeyPrefix,
  environmentQueryKey,
  environmentWorkStatusQueryKey,
  environmentWorkStatusQueryKeyPrefix,
  hostsQueryKey,
  systemProvidersQueryKey,
  threadQueryKey,
  threadTimelineQueryKeyPrefix,
  threadStorageFilesQueryKey,
  threadStorageFilePreviewQueryKeyPrefix,
  threadsQueryKey,
} from "./queries/query-keys";
import {
  shouldFlushThreadChangesImmediately,
  useWebSocket,
} from "./useWebSocket";

interface ConnectedEvent {
  reconnected: boolean;
}

type WebSocketConnectionState =
  | "connecting"
  | "connected"
  | "reconnecting";

interface ChangedMessage {
  changes: string[];
  entity: "host" | "thread" | "project" | "environment" | "system";
  id?: string;
  type: "changed";
}

type ChangedCallback = (message: ChangedMessage) => void;
type ConnectedCallback = (event: ConnectedEvent) => void;
type ConnectionStateCallback = () => void;

const {
  changedCallbacks,
  connectedCallbacks,
  connectionStateCallbacks,
  connect,
  disconnect,
  subscribe,
  unsubscribe,
} = vi.hoisted(() => {
  const changedCallbacks: ChangedCallback[] = [];
  const connectedCallbacks: ConnectedCallback[] = [];
  const connectionStateCallbacks: ConnectionStateCallback[] = [];

  return {
    changedCallbacks,
    connectedCallbacks,
    connectionStateCallbacks,
    connect: vi.fn(),
    disconnect: vi.fn(),
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
  };
});

vi.mock("../lib/ws", () => ({
  wsManager: {
    connect,
    disconnect,
    subscribe,
    unsubscribe,
    getConnectionState(): WebSocketConnectionState {
      return "connected";
    },
    onChanged(callback: ChangedCallback) {
      changedCallbacks.push(callback);
      return () => {
        const index = changedCallbacks.indexOf(callback);
        if (index >= 0) {
          changedCallbacks.splice(index, 1);
        }
      };
    },
    onConnected(callback: ConnectedCallback) {
      connectedCallbacks.push(callback);
      return () => {
        const index = connectedCallbacks.indexOf(callback);
        if (index >= 0) {
          connectedCallbacks.splice(index, 1);
        }
      };
    },
    onConnectionStateChange(callback: ConnectionStateCallback) {
      connectionStateCallbacks.push(callback);
      return () => {
        const index = connectionStateCallbacks.indexOf(callback);
        if (index >= 0) {
          connectionStateCallbacks.splice(index, 1);
        }
      };
    },
  },
}));

afterEach(() => {
  changedCallbacks.length = 0;
  connectedCallbacks.length = 0;
  connectionStateCallbacks.length = 0;
  vi.useRealTimers();
  vi.clearAllMocks();
});

function createThread(args: {
  environmentId: string | null;
  id: string;
}): Thread {
  return {
    id: args.id,
    projectId: "proj-1",
    environmentId: args.environmentId,
    providerId: "codex",
    type: "manager",
    title: "Manager",
    titleFallback: "Manager",
    status: "idle",
    automationId: null,
    parentThreadId: null,
    archivedAt: null,
    stopRequestedAt: null,
    deletedAt: null,
    lastReadAt: null,
    latestAttentionAt: 1,
    createdAt: 1,
    updatedAt: 1,
  };
}

describe("shouldFlushThreadChangesImmediately", () => {
  it("flushes status changes immediately", () => {
    expect(
      shouldFlushThreadChangesImmediately([
        "events-appended",
        "status-changed",
      ]),
    ).toBe(true);
  });

  it("does not fast-flush pure timeline appends", () => {
    expect(shouldFlushThreadChangesImmediately(["events-appended"])).toBe(false);
  });
});

describe("useWebSocket", () => {
  it("invalidates host-dependent queries when host status changes", () => {
    const { queryClient, wrapper } = createQueryClientTestHarness();
    const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries");

    renderHook(() => useWebSocket(), { wrapper });

    act(() => {
      changedCallbacks[0]?.({
        changes: ["host-connected"],
        entity: "host",
        type: "changed",
      });
    });

    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: hostsQueryKey(),
    });
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: allHostQueryKeyPrefix(),
    });
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: systemProvidersQueryKey(),
    });
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: allAvailableModelsQueryKeyPrefix(),
    });
  });

  it("invalidates thread storage queries for cached environment threads", () => {
    vi.useFakeTimers();
    const { queryClient, wrapper } = createQueryClientTestHarness();
    const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries");
    const thread = createThread({
      environmentId: "env-1",
      id: "thread-1",
    });
    queryClient.setQueryData(threadQueryKey(thread.id), thread);
    queryClient.setQueryData(threadsQueryKey(), [thread]);

    renderHook(() => useWebSocket(), { wrapper });

    act(() => {
      changedCallbacks[0]?.({
        changes: ["thread-storage-changed"],
        entity: "environment",
        id: "env-1",
        type: "changed",
      });
      vi.advanceTimersByTime(500);
    });

    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: threadStorageFilesQueryKey("thread-1"),
    });
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: threadStorageFilePreviewQueryKeyPrefix("thread-1"),
    });
    expect(invalidateQueries).not.toHaveBeenCalledWith({
      queryKey: environmentQueryKey("env-1"),
    });
    expect(invalidateQueries).not.toHaveBeenCalledWith({
      queryKey: environmentWorkStatusQueryKeyPrefix("env-1"),
    });
    expect(invalidateQueries).not.toHaveBeenCalledWith({
      queryKey: environmentGitDiffQueryKeyPrefix("env-1"),
    });
    expect(invalidateQueries).not.toHaveBeenCalledWith({
      queryKey: environmentMergeBaseBranchesQueryKeyPrefix("env-1"),
    });
  });

  it("invalidates workspace-derived queries but not the persisted environment record for work-status changes", () => {
    vi.useFakeTimers();
    const { queryClient, wrapper } = createQueryClientTestHarness();
    const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries");

    renderHook(() => useWebSocket(), { wrapper });

    act(() => {
      changedCallbacks[0]?.({
        changes: ["work-status-changed"],
        entity: "environment",
        id: "env-1",
        type: "changed",
      });
      vi.advanceTimersByTime(500);
    });

    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: environmentWorkStatusQueryKeyPrefix("env-1"),
    });
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: environmentGitDiffQueryKeyPrefix("env-1"),
    });
    expect(invalidateQueries).not.toHaveBeenCalledWith({
      queryKey: environmentQueryKey("env-1"),
    });
    expect(invalidateQueries).not.toHaveBeenCalledWith({
      queryKey: environmentMergeBaseBranchesQueryKeyPrefix("env-1"),
    });
  });

  it("invalidates only merge-base-dependent queries for shared git ref changes without touching plain work status", () => {
    vi.useFakeTimers();
    const { queryClient, wrapper } = createQueryClientTestHarness();
    const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries");
    const plainWorkStatusQueryKey = environmentWorkStatusQueryKey("env-1", null);
    const mergeBaseWorkStatusQueryKey = environmentWorkStatusQueryKey("env-1", "main");
    const mergeBaseBranchesQueryKey = environmentMergeBaseBranchesQueryKey("env-1");
    const branchGitDiffQueryKey = environmentGitDiffQueryKey("env-1", "all", "main");
    const commitGitDiffQueryKey = environmentGitDiffQueryKey("env-1", "commit", "abc123");

    queryClient.setQueryData(plainWorkStatusQueryKey, null);
    queryClient.setQueryData(mergeBaseWorkStatusQueryKey, null);
    queryClient.setQueryData(mergeBaseBranchesQueryKey, ["main"]);
    queryClient.setQueryData(branchGitDiffQueryKey, {
      diff: "",
      truncated: false,
      shortstat: "",
      files: "",
    });
    queryClient.setQueryData(commitGitDiffQueryKey, {
      diff: "",
      truncated: false,
      shortstat: "",
      files: "",
    });

    renderHook(() => useWebSocket(), { wrapper });

    act(() => {
      changedCallbacks[0]?.({
        changes: ["git-refs-changed"],
        entity: "environment",
        id: "env-1",
        type: "changed",
      });
      vi.advanceTimersByTime(500);
    });

    expect(invalidateQueries).toHaveBeenCalledWith({
      exact: true,
      queryKey: mergeBaseWorkStatusQueryKey,
    });
    expect(invalidateQueries).toHaveBeenCalledWith({
      exact: true,
      queryKey: branchGitDiffQueryKey,
    });
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: environmentMergeBaseBranchesQueryKeyPrefix("env-1"),
    });
    expect(invalidateQueries).not.toHaveBeenCalledWith({
      queryKey: environmentWorkStatusQueryKeyPrefix("env-1"),
    });
    expect(invalidateQueries).not.toHaveBeenCalledWith({
      queryKey: environmentGitDiffQueryKeyPrefix("env-1"),
    });
    expect(invalidateQueries).not.toHaveBeenCalledWith({
      queryKey: environmentQueryKey("env-1"),
    });
    expect(queryClient.getQueryState(plainWorkStatusQueryKey)?.isInvalidated).not.toBe(true);
    expect(queryClient.getQueryState(mergeBaseWorkStatusQueryKey)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(mergeBaseBranchesQueryKey)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(branchGitDiffQueryKey)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(commitGitDiffQueryKey)?.isInvalidated).not.toBe(true);
  });

  it("invalidates persisted environment, workspace, and branch queries for metadata changes", () => {
    vi.useFakeTimers();
    const { queryClient, wrapper } = createQueryClientTestHarness();
    const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries");

    renderHook(() => useWebSocket(), { wrapper });

    act(() => {
      changedCallbacks[0]?.({
        changes: ["metadata-changed"],
        entity: "environment",
        id: "env-1",
        type: "changed",
      });
      vi.advanceTimersByTime(500);
    });

    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: environmentQueryKey("env-1"),
    });
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: environmentWorkStatusQueryKeyPrefix("env-1"),
    });
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: environmentGitDiffQueryKeyPrefix("env-1"),
    });
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: environmentMergeBaseBranchesQueryKeyPrefix("env-1"),
    });
  });

  it("invalidates persisted environment, workspace, and branch queries for status changes", () => {
    vi.useFakeTimers();
    const { queryClient, wrapper } = createQueryClientTestHarness();
    const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries");

    renderHook(() => useWebSocket(), { wrapper });

    act(() => {
      changedCallbacks[0]?.({
        changes: ["status-changed"],
        entity: "environment",
        id: "env-1",
        type: "changed",
      });
      vi.advanceTimersByTime(500);
    });

    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: environmentQueryKey("env-1"),
    });
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: environmentWorkStatusQueryKeyPrefix("env-1"),
    });
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: environmentGitDiffQueryKeyPrefix("env-1"),
    });
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: environmentMergeBaseBranchesQueryKeyPrefix("env-1"),
    });
  });

  it("invalidates both environment and thread storage queries when both change kinds are present", () => {
    vi.useFakeTimers();
    const { queryClient, wrapper } = createQueryClientTestHarness();
    const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries");
    const thread = createThread({
      environmentId: "env-1",
      id: "thread-1",
    });
    queryClient.setQueryData(threadQueryKey(thread.id), thread);
    queryClient.setQueryData(threadsQueryKey(), [thread]);

    renderHook(() => useWebSocket(), { wrapper });

    act(() => {
      changedCallbacks[0]?.({
        changes: ["work-status-changed", "thread-storage-changed"],
        entity: "environment",
        id: "env-1",
        type: "changed",
      });
      vi.advanceTimersByTime(500);
    });

    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: environmentWorkStatusQueryKeyPrefix("env-1"),
    });
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: environmentGitDiffQueryKeyPrefix("env-1"),
    });
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: threadStorageFilesQueryKey("thread-1"),
    });
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: threadStorageFilePreviewQueryKeyPrefix("thread-1"),
    });
  });

  it("invalidates pending interaction queries and timeline state for thread interaction changes", () => {
    vi.useFakeTimers();
    const { queryClient, wrapper } = createQueryClientTestHarness();
    const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries");

    renderHook(() => useWebSocket(), { wrapper });

    act(() => {
      changedCallbacks[0]?.({
        changes: ["interactions-changed"],
        entity: "thread",
        id: "thread-1",
        type: "changed",
      });
      vi.advanceTimersByTime(500);
    });

    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: threadPendingInteractionsQueryKey("thread-1"),
    });
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: threadTimelineQueryKeyPrefix("thread-1"),
    });
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: threadQueryKey("thread-1"),
    });
  });
});
