// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import {
  allAvailableModelsQueryKeyPrefix,
  hostsQueryKey,
  systemProvidersQueryKey,
} from "./queries/query-keys";
import {
  createBufferedEnvironmentInvalidator,
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
  vi.clearAllMocks();
  vi.useRealTimers();
});

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
});

describe("createBufferedEnvironmentInvalidator", () => {
  it("deduplicates repeated environment changes within the debounce window", () => {
    vi.useFakeTimers();
    const flushChangedEnvironmentIds = vi.fn();
    const invalidator = createBufferedEnvironmentInvalidator({
      debounceMs: 100,
      flushChangedEnvironmentIds,
      maxWaitMs: 300,
    });

    invalidator.markChanged("env-1");
    vi.advanceTimersByTime(50);
    invalidator.markChanged("env-1");
    vi.advanceTimersByTime(99);

    expect(flushChangedEnvironmentIds).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);

    expect(flushChangedEnvironmentIds).toHaveBeenCalledTimes(1);
    expect(flushChangedEnvironmentIds).toHaveBeenCalledWith(["env-1"]);
  });

  it("flushes multiple changed environments together at max wait", () => {
    vi.useFakeTimers();
    const flushChangedEnvironmentIds = vi.fn();
    const invalidator = createBufferedEnvironmentInvalidator({
      debounceMs: 100,
      flushChangedEnvironmentIds,
      maxWaitMs: 250,
    });

    invalidator.markChanged("env-1");
    vi.advanceTimersByTime(90);
    invalidator.markChanged("env-2");
    vi.advanceTimersByTime(90);
    invalidator.markChanged("env-1");
    vi.advanceTimersByTime(69);

    expect(flushChangedEnvironmentIds).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);

    expect(flushChangedEnvironmentIds).toHaveBeenCalledTimes(1);
    expect(flushChangedEnvironmentIds).toHaveBeenCalledWith(["env-1", "env-2"]);
  });

  it("cancels pending flushes during dispose", () => {
    vi.useFakeTimers();
    const flushChangedEnvironmentIds = vi.fn();
    const invalidator = createBufferedEnvironmentInvalidator({
      debounceMs: 100,
      flushChangedEnvironmentIds,
      maxWaitMs: 250,
    });

    invalidator.markChanged("env-1");
    invalidator.dispose();
    vi.runAllTimers();

    expect(flushChangedEnvironmentIds).not.toHaveBeenCalled();
  });
});
