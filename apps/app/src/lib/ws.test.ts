import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clientMessageSchema, type ClientMessage } from "@bb/domain";
import type { RealtimeSubscriptionTarget } from "@bb/server-contract";

const fakeSocketState = vi.hoisted(() => {
  type CloseHandler = () => void;
  type MessageHandler = (event: MessageEvent) => void;
  type OpenHandler = () => void;

  class FakeReconnectingWebSocket {
    onclose: CloseHandler | null = null;
    onmessage: MessageHandler | null = null;
    onopen: OpenHandler | null = null;
    readyState = 1;
    readonly sentMessages: string[] = [];

    constructor() {
      instances.push(this);
    }

    close(): void {
      this.readyState = 3;
      this.onclose?.();
    }

    open(): void {
      this.readyState = 1;
      this.onopen?.();
    }

    send(data: string): void {
      this.sentMessages.push(data);
    }
  }

  const instances: FakeReconnectingWebSocket[] = [];

  return {
    FakeReconnectingWebSocket,
    instances,
  };
});

vi.mock("partysocket/ws", () => ({
  default: fakeSocketState.FakeReconnectingWebSocket,
}));

vi.mock("./dev-websocket-url", () => ({
  buildDevWebSocketUrl: () => "ws://bb.test/ws",
}));

import {
  REALTIME_PING_INTERVAL_MS,
  REALTIME_PONG_TIMEOUT_MS,
  WebSocketManager,
  type WebSocketConnectedEvent,
  type WebSocketManagerBrowserEvents,
} from "./ws";

const THREAD_TARGET = {
  kind: "thread-detail",
  threadId: "thr_1",
} satisfies RealtimeSubscriptionTarget;
const PROJECT_TARGET = {
  kind: "project-list",
} satisfies RealtimeSubscriptionTarget;

interface ConnectedManager {
  manager: WebSocketManager;
  socket: FakeSocket;
}

interface FakeSocket {
  readonly sentMessages: string[];
  close: () => void;
  open: () => void;
}

function installOpenWebSocketConstructor(): void {
  Object.defineProperty(globalThis, "WebSocket", {
    configurable: true,
    value: {
      CONNECTING: 0,
      OPEN: 1,
      CLOSING: 2,
      CLOSED: 3,
    },
  });
}

function readClientMessages(socket: FakeSocket): readonly ClientMessage[] {
  return socket.sentMessages.map((message) =>
    clientMessageSchema.parse(JSON.parse(message)),
  );
}

function getOnlySocket(): FakeSocket {
  const socket = fakeSocketState.instances[0];
  if (!socket) {
    throw new Error("Expected websocket to be created");
  }
  return socket;
}

function createConnectedManager(): ConnectedManager {
  const manager = new WebSocketManager();
  manager.connect();
  const socket = getOnlySocket();
  socket.open();
  return { manager, socket };
}

describe("WebSocketManager subscriptions", () => {
  const originalWebSocket = globalThis.WebSocket;

  beforeEach(() => {
    fakeSocketState.instances.length = 0;
    installOpenWebSocketConstructor();
  });

  afterEach(() => {
    Object.defineProperty(globalThis, "WebSocket", {
      configurable: true,
      value: originalWebSocket,
    });
  });

  it("ref-counts duplicate subscriptions and unsubscribes only after the final cleanup", () => {
    const { manager, socket } = createConnectedManager();

    manager.subscribe(THREAD_TARGET);
    manager.subscribe(THREAD_TARGET);

    expect(readClientMessages(socket)).toEqual([
      {
        type: "subscribe",
        target: THREAD_TARGET,
      },
    ]);

    manager.unsubscribe(THREAD_TARGET);

    expect(readClientMessages(socket)).toEqual([
      {
        type: "subscribe",
        target: THREAD_TARGET,
      },
    ]);

    manager.unsubscribe(THREAD_TARGET);

    expect(readClientMessages(socket)).toEqual([
      {
        type: "subscribe",
        target: THREAD_TARGET,
      },
      {
        type: "unsubscribe",
        target: THREAD_TARGET,
      },
    ]);
  });

  it("resends active subscriptions when the websocket reconnects", () => {
    const { manager, socket } = createConnectedManager();

    manager.subscribe(THREAD_TARGET);
    manager.subscribe(PROJECT_TARGET);
    socket.sentMessages.length = 0;

    socket.close();
    socket.open();

    expect(readClientMessages(socket)).toEqual([
      {
        type: "subscribe",
        target: THREAD_TARGET,
      },
      {
        type: "subscribe",
        target: PROJECT_TARGET,
      },
    ]);
  });
});

describe("WebSocketManager thread-open signals", () => {
  const originalWebSocket = globalThis.WebSocket;

  beforeEach(() => {
    fakeSocketState.instances.length = 0;
    installOpenWebSocketConstructor();
  });

  afterEach(() => {
    Object.defineProperty(globalThis, "WebSocket", {
      configurable: true,
      value: originalWebSocket,
    });
  });

  function dispatchRaw(payload: unknown): void {
    const instance = fakeSocketState.instances[0];
    if (!instance) {
      throw new Error("Expected websocket instance");
    }
    instance.onmessage?.({ data: JSON.stringify(payload) } as MessageEvent);
  }

  it("notifies layout listeners and buffers an included file once", () => {
    const { manager } = createConnectedManager();
    const threadOpen = vi.fn();
    const changed = vi.fn();
    manager.onThreadOpen(threadOpen);
    manager.onChanged(changed);

    const signal = {
      type: "thread-open",
      projectId: "proj_1",
      threadId: "thr_1",
      split: "right",
      file: {
        source: "workspace",
        path: "src/index.ts",
        lineNumber: 7,
      },
    };
    dispatchRaw(signal);

    expect(threadOpen).toHaveBeenCalledWith(signal);
    expect(changed).not.toHaveBeenCalled();
    expect(manager.consumePendingOpenFile("thr_1")).toEqual(signal.file);
    expect(manager.consumePendingOpenFile("thr_1")).toBeNull();
  });

  it("still routes changed messages to onChanged", () => {
    const { manager } = createConnectedManager();
    const changed = vi.fn();
    const threadOpen = vi.fn();
    manager.onChanged(changed);
    manager.onThreadOpen(threadOpen);

    dispatchRaw({
      type: "changed",
      entity: "thread",
      id: "thr_1",
      changes: ["events-appended"],
    });

    expect(changed).toHaveBeenCalledTimes(1);
    expect(threadOpen).not.toHaveBeenCalled();
  });

  it("routes typed thread-pane actions separately", () => {
    const { manager } = createConnectedManager();
    const paneAction = vi.fn();
    const threadOpen = vi.fn();
    manager.onThreadPaneAction(paneAction);
    manager.onThreadOpen(threadOpen);

    const signal = {
      type: "thread-pane-action",
      projectId: "proj_1",
      threadId: "thr_1",
      action: "spotlight",
    } as const;
    dispatchRaw(signal);

    expect(paneAction).toHaveBeenCalledWith(signal);
    expect(threadOpen).not.toHaveBeenCalled();
  });
});

interface FakeBrowserEvents extends WebSocketManagerBrowserEvents {
  setVisible: (visible: boolean) => void;
  goOnline: () => void;
}

function createFakeBrowserEvents(): FakeBrowserEvents {
  let visible = true;
  const visibilityListeners = new Set<() => void>();
  const onlineListeners = new Set<() => void>();
  return {
    isDocumentVisible: () => visible,
    subscribeToVisibility: (listener) => {
      visibilityListeners.add(listener);
      return () => {
        visibilityListeners.delete(listener);
      };
    },
    subscribeToOnline: (listener) => {
      onlineListeners.add(listener);
      return () => {
        onlineListeners.delete(listener);
      };
    },
    setVisible: (nextVisible) => {
      visible = nextVisible;
      for (const listener of visibilityListeners) {
        listener();
      }
    },
    goOnline: () => {
      for (const listener of onlineListeners) {
        listener();
      }
    },
  };
}

function getSocketAt(index: number): FakeSocket & {
  onmessage: ((event: MessageEvent) => void) | null;
  readyState: number;
} {
  const socket = fakeSocketState.instances[index];
  if (!socket) {
    throw new Error(`Expected websocket instance #${index}`);
  }
  return socket;
}

function receive(
  socket: { onmessage: ((event: MessageEvent) => void) | null },
  payload: unknown,
): void {
  socket.onmessage?.({ data: JSON.stringify(payload) } as MessageEvent);
}

function pingCount(socket: FakeSocket): number {
  return readClientMessages(socket).filter((message) => message.type === "ping")
    .length;
}

describe("WebSocketManager liveness", () => {
  const originalWebSocket = globalThis.WebSocket;

  beforeEach(() => {
    fakeSocketState.instances.length = 0;
    installOpenWebSocketConstructor();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    Object.defineProperty(globalThis, "WebSocket", {
      configurable: true,
      value: originalWebSocket,
    });
  });

  function createLiveManager(browserEvents = createFakeBrowserEvents()) {
    const manager = new WebSocketManager(browserEvents);
    const connectedEvents: WebSocketConnectedEvent[] = [];
    manager.onConnected((event) => connectedEvents.push(event));
    manager.connect();
    const socket = getSocketAt(0);
    socket.open();
    return { browserEvents, connectedEvents, manager, socket };
  }

  it("pings an idle visible socket on the interval and reconnects when no frame answers", () => {
    const { connectedEvents, socket } = createLiveManager();
    const openedAt = Date.now();

    vi.advanceTimersByTime(REALTIME_PING_INTERVAL_MS);
    expect(pingCount(socket)).toBe(1);
    receive(socket, { type: "pong" });
    vi.advanceTimersByTime(REALTIME_PONG_TIMEOUT_MS);
    expect(fakeSocketState.instances).toHaveLength(1);

    vi.advanceTimersByTime(
      REALTIME_PING_INTERVAL_MS - REALTIME_PONG_TIMEOUT_MS,
    );
    expect(pingCount(socket)).toBe(2);
    const lastActivityAt = openedAt + REALTIME_PING_INTERVAL_MS;
    vi.advanceTimersByTime(REALTIME_PONG_TIMEOUT_MS);

    expect(fakeSocketState.instances).toHaveLength(2);
    expect(socket.readyState).toBe(3);
    const replacement = getSocketAt(1);
    replacement.open();
    expect(connectedEvents).toEqual([
      { reconnected: false },
      { reconnected: true, disconnectedAt: lastActivityAt },
    ]);
  });

  it("treats any inbound frame as liveness and skips pings while frames flow", () => {
    const { socket } = createLiveManager();

    vi.advanceTimersByTime(REALTIME_PING_INTERVAL_MS - 1000);
    receive(socket, {
      type: "changed",
      entity: "thread",
      id: "thr_1",
      changes: ["events-appended"],
    });
    vi.advanceTimersByTime(1000);
    expect(pingCount(socket)).toBe(0);

    vi.advanceTimersByTime(REALTIME_PING_INTERVAL_MS);
    expect(pingCount(socket)).toBe(1);
    receive(socket, {
      type: "changed",
      entity: "thread",
      id: "thr_1",
      changes: ["events-appended"],
    });
    vi.advanceTimersByTime(REALTIME_PONG_TIMEOUT_MS);
    expect(fakeSocketState.instances).toHaveLength(1);
  });

  it("does not ping while hidden and probes once on becoming visible", () => {
    const { browserEvents, socket } = createLiveManager();

    browserEvents.setVisible(false);
    vi.advanceTimersByTime(REALTIME_PING_INTERVAL_MS * 4);
    expect(pingCount(socket)).toBe(0);

    browserEvents.setVisible(true);
    expect(pingCount(socket)).toBe(1);
    receive(socket, { type: "pong" });
    vi.advanceTimersByTime(REALTIME_PING_INTERVAL_MS);
    expect(pingCount(socket)).toBe(2);
  });

  it("reconnects immediately on visible or online when the socket is closed", () => {
    const { browserEvents, connectedEvents, socket } = createLiveManager();

    browserEvents.setVisible(false);
    socket.close();
    const closedAt = Date.now();
    vi.advanceTimersByTime(500);
    expect(fakeSocketState.instances).toHaveLength(1);

    browserEvents.setVisible(true);
    expect(fakeSocketState.instances).toHaveLength(2);
    getSocketAt(1).open();
    expect(connectedEvents.at(-1)).toEqual({
      reconnected: true,
      disconnectedAt: closedAt,
    });

    getSocketAt(1).close();
    browserEvents.goOnline();
    expect(fakeSocketState.instances).toHaveLength(3);
  });

  it("reconnects immediately when the socket closes while a probe is outstanding", () => {
    const { browserEvents, connectedEvents, socket } = createLiveManager();
    const openedAt = Date.now();

    browserEvents.setVisible(false);
    vi.advanceTimersByTime(60_000);
    browserEvents.setVisible(true);
    expect(pingCount(socket)).toBe(1);
    vi.advanceTimersByTime(1000);
    socket.close();

    expect(fakeSocketState.instances).toHaveLength(2);
    getSocketAt(1).open();
    expect(connectedEvents.at(-1)).toEqual({
      reconnected: true,
      disconnectedAt: openedAt,
    });
    vi.advanceTimersByTime(REALTIME_PONG_TIMEOUT_MS);
    expect(fakeSocketState.instances).toHaveLength(2);
  });

  it("re-sends subscriptions on the replacement socket after a failed probe", () => {
    const { manager } = createLiveManager();
    manager.subscribe(THREAD_TARGET);

    vi.advanceTimersByTime(
      REALTIME_PING_INTERVAL_MS + REALTIME_PONG_TIMEOUT_MS,
    );
    const replacement = getSocketAt(1);
    replacement.open();

    expect(readClientMessages(replacement)).toEqual([
      { type: "subscribe", target: THREAD_TARGET },
    ]);
    expect(manager.getConnectionState()).toBe("connected");
  });
});
