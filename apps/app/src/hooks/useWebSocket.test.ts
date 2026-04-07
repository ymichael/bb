// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Thread } from "@bb/domain";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import {
  allAvailableModelsQueryKeyPrefix,
  environmentGitDiffQueryKeyPrefix,
  environmentMergeBaseBranchesQueryKeyPrefix,
  environmentQueryKey,
  environmentWorkStatusQueryKeyPrefix,
  hostsQueryKey,
  systemProvidersQueryKey,
  threadQueryKey,
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

  it("invalidates workspace-derived and branch queries for shared git ref changes without touching the persisted environment record", () => {
    vi.useFakeTimers();
    const { queryClient, wrapper } = createQueryClientTestHarness();
    const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries");

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
      queryKey: environmentWorkStatusQueryKeyPrefix("env-1"),
    });
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: environmentGitDiffQueryKeyPrefix("env-1"),
    });
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: environmentMergeBaseBranchesQueryKeyPrefix("env-1"),
    });
    expect(invalidateQueries).not.toHaveBeenCalledWith({
      queryKey: environmentQueryKey("env-1"),
    });
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
});
