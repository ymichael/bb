import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeSocketFactory } from "./fake-socket";
import {
  createMobileRealtime,
  REALTIME_PING_INTERVAL_MS,
  REALTIME_PONG_TIMEOUT_MS,
  reconnectDelayMs,
  type CreateMobileRealtimeOptions,
  type MobileRealtime,
  type MobileRealtimeConnectedEvent,
} from "./mobile-realtime";

const THREAD_TARGET = { kind: "thread-detail", threadId: "t1" } as const;
const LIST_TARGET = { kind: "thread-list" } as const;

function setup(overrides: Partial<CreateMobileRealtimeOptions> = {}) {
  const factory = createFakeSocketFactory();
  const realtime: MobileRealtime = createMobileRealtime({
    url: "ws://127.0.0.1:20304/ws",
    socketFactory: factory,
    onInvalidMessage: () => {},
    ...overrides,
  });
  return { factory, realtime };
}

describe("createMobileRealtime", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("subscribes on open with refcounting and unsubscribes only when the last holder leaves", () => {
    const { factory, realtime } = setup();
    realtime.subscribe(THREAD_TARGET);
    realtime.subscribe(THREAD_TARGET);
    realtime.subscribe(LIST_TARGET);
    realtime.connect();
    const socket = factory.latest();
    expect(socket.sent).toEqual([]);

    socket.open();
    expect(realtime.getConnectionState()).toBe("connected");
    expect(socket.sentMessages()).toEqual([
      { type: "subscribe", target: THREAD_TARGET },
      { type: "subscribe", target: LIST_TARGET },
    ]);

    realtime.unsubscribe(THREAD_TARGET);
    expect(socket.sentMessages()).toHaveLength(2);
    realtime.unsubscribe(THREAD_TARGET);
    expect(socket.sentMessages().at(-1)).toEqual({
      type: "unsubscribe",
      target: THREAD_TARGET,
    });
    realtime.unsubscribe(THREAD_TARGET);
    expect(socket.sentMessages()).toHaveLength(3);

    realtime.subscribe({ kind: "system" });
    expect(socket.sentMessages().at(-1)).toEqual({
      type: "subscribe",
      target: { kind: "system" },
    });
  });

  it("reconnects with growing backoff, resubscribes, and reports reconnected", () => {
    const { factory, realtime } = setup();
    const connected: boolean[] = [];
    const states: string[] = [];
    realtime.onConnected(({ reconnected }) => connected.push(reconnected));
    realtime.onConnectionStateChange(() =>
      states.push(realtime.getConnectionState()),
    );
    realtime.subscribe(THREAD_TARGET);
    realtime.connect();
    factory.latest().open();
    expect(connected).toEqual([false]);

    factory.latest().drop();
    expect(realtime.getConnectionState()).toBe("reconnecting");
    expect(factory.sockets).toHaveLength(1);

    vi.advanceTimersByTime(999);
    expect(factory.sockets).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(factory.sockets).toHaveLength(2);

    factory.latest().drop();
    vi.advanceTimersByTime(1499);
    expect(factory.sockets).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(factory.sockets).toHaveLength(3);

    factory.latest().drop();
    vi.advanceTimersByTime(2250);
    expect(factory.sockets).toHaveLength(4);

    factory.latest().open();
    expect(connected).toEqual([false, true]);
    expect(factory.latest().sentMessages()).toEqual([
      { type: "subscribe", target: THREAD_TARGET },
    ]);
    expect(states).toEqual(["connected", "reconnecting", "connected"]);

    factory.latest().drop();
    vi.advanceTimersByTime(1000);
    expect(factory.sockets).toHaveLength(5);
  });

  it("caps the backoff at 30s", () => {
    const options = { minDelayMs: 1000, maxDelayMs: 30_000, growFactor: 1.5 };
    expect(reconnectDelayMs(0, options)).toBe(1000);
    expect(reconnectDelayMs(1, options)).toBe(1500);
    expect(reconnectDelayMs(8, options)).toBe(25_629);
    expect(reconnectDelayMs(9, options)).toBe(30_000);
    expect(reconnectDelayMs(50, options)).toBe(30_000);
  });

  it("reports attempts that never open, flagging refused upgrades that name an auth status", () => {
    const { factory, realtime } = setup({ connectionTimeoutMs: 5000 });
    const failures: { message: string | null; authRejected: boolean }[] = [];
    realtime.onConnectFailed((event) => failures.push(event));
    realtime.connect();
    factory.latest().reject("Received bad response code from server: 401.");
    expect(failures).toEqual([
      {
        message: "Received bad response code from server: 401.",
        authRejected: true,
      },
    ]);
    vi.advanceTimersByTime(1000);
    factory
      .latest()
      .reject("Expected HTTP 101 response but was '401 Unauthorized'", true);
    expect(failures[1]).toEqual({
      message: "Expected HTTP 101 response but was '401 Unauthorized'",
      authRejected: true,
    });
    vi.advanceTimersByTime(1500);
    factory.latest().drop();
    expect(failures[2]).toEqual({ message: null, authRejected: false });
    vi.advanceTimersByTime(2250);
    vi.advanceTimersByTime(5000);
    expect(failures[3]).toEqual({
      message: "handshake timeout",
      authRejected: false,
    });
    vi.advanceTimersByTime(4000);
    factory.latest().open();
    factory.latest().drop();
    expect(failures).toHaveLength(4);
    expect(realtime.getConnectionState()).toBe("reconnecting");
  });

  it("gives up on a stalled handshake after the connection timeout and retries", () => {
    const { factory, realtime } = setup({ connectionTimeoutMs: 5000 });
    realtime.connect();
    const first = factory.latest();
    vi.advanceTimersByTime(5000);
    expect(first.closes).toHaveLength(1);
    expect(realtime.getConnectionState()).toBe("connecting");
    vi.advanceTimersByTime(1000);
    expect(factory.sockets).toHaveLength(2);
    first.open();
    expect(realtime.getConnectionState()).toBe("connecting");
  });

  it("suspend closes the socket without reconnecting; resume reconnects and replays subscriptions", () => {
    const { factory, realtime } = setup();
    const connected: boolean[] = [];
    realtime.onConnected(({ reconnected }) => connected.push(reconnected));
    realtime.subscribe(THREAD_TARGET);
    realtime.connect();
    factory.latest().open();

    realtime.suspend();
    expect(factory.latest().closes).toHaveLength(1);
    expect(realtime.isSuspended()).toBe(true);
    expect(realtime.getConnectionState()).toBe("reconnecting");
    vi.advanceTimersByTime(60_000);
    expect(factory.sockets).toHaveLength(1);

    realtime.subscribe(LIST_TARGET);
    realtime.unsubscribe(THREAD_TARGET);

    realtime.resume();
    expect(factory.sockets).toHaveLength(2);
    factory.latest().open();
    expect(connected).toEqual([false, true]);
    expect(factory.latest().sentMessages()).toEqual([
      { type: "subscribe", target: LIST_TARGET },
    ]);
    expect(realtime.getConnectionState()).toBe("connected");
  });

  it("suspend during a pending reconnect cancels the retry; resume retries immediately", () => {
    const { factory, realtime } = setup();
    realtime.connect();
    factory.latest().open();
    factory.latest().drop();
    realtime.suspend();
    vi.advanceTimersByTime(60_000);
    expect(factory.sockets).toHaveLength(1);
    realtime.resume();
    expect(factory.sockets).toHaveLength(2);
  });

  it("does not open a socket on resume when connect() was never called or after disconnect()", () => {
    const { factory, realtime } = setup();
    realtime.suspend();
    realtime.resume();
    expect(factory.sockets).toHaveLength(0);

    realtime.connect();
    factory.latest().open();
    realtime.disconnect();
    expect(factory.latest().closes).toHaveLength(1);
    realtime.suspend();
    realtime.resume();
    expect(factory.sockets).toHaveLength(1);
    expect(realtime.getConnectionState()).toBe("connecting");
  });

  it("connect() while suspended defers the socket until resume", () => {
    const { factory, realtime } = setup();
    realtime.suspend();
    realtime.connect();
    expect(factory.sockets).toHaveLength(0);
    realtime.resume();
    expect(factory.sockets).toHaveLength(1);
  });

  it("routes thread-open, pane-action, plugin-signal and changed frames leniently", () => {
    const { factory, realtime } = setup();
    const changed: unknown[] = [];
    const opens: unknown[] = [];
    const panes: unknown[] = [];
    const signals: unknown[] = [];
    realtime.onChanged((m) => changed.push(m));
    realtime.onThreadOpen((s) => opens.push(s));
    realtime.onThreadPaneAction((s) => panes.push(s));
    realtime.onPluginSignal((s) => signals.push(s));
    realtime.connect();
    const socket = factory.latest();
    socket.open();

    socket.receive(
      JSON.stringify({
        type: "changed",
        entity: "thread",
        id: "t1",
        changes: ["events-appended", "future-kind"],
        metadata: { hasPendingInteraction: true, newField: 1 },
        extra: true,
      }),
    );
    socket.receive(
      JSON.stringify({
        type: "thread-open",
        projectId: "p1",
        threadId: "t1",
        split: "replace",
        file: { source: "workspace", path: "src/a.ts", lineNumber: 3 },
        newField: "x",
      }),
    );
    socket.receive(
      JSON.stringify({
        type: "thread-pane-action",
        projectId: "p1",
        threadId: "t1",
        action: "maximize",
      }),
    );
    socket.receive(
      JSON.stringify({
        type: "plugin-signal",
        pluginId: "tasks",
        channel: "updated",
        payload: { id: 1 },
      }),
    );
    socket.receive("not json");
    socket.receive(new ArrayBuffer(2));
    socket.receive(JSON.stringify({ type: "changed", entity: "martian" }));

    expect(changed).toEqual([
      {
        type: "changed",
        entity: "thread",
        id: "t1",
        changes: ["events-appended"],
        metadata: { hasPendingInteraction: true },
      },
    ]);
    expect(opens).toEqual([
      {
        type: "thread-open",
        projectId: "p1",
        threadId: "t1",
        split: "replace",
        file: { source: "workspace", path: "src/a.ts", lineNumber: 3 },
      },
    ]);
    expect(realtime.consumePendingOpenFile("t1")).toEqual({
      source: "workspace",
      path: "src/a.ts",
      lineNumber: 3,
    });
    expect(realtime.consumePendingOpenFile("t1")).toBeNull();
    expect(panes).toEqual([
      {
        type: "thread-pane-action",
        projectId: "p1",
        threadId: "t1",
        action: "maximize",
      },
    ]);
    expect(signals).toEqual([
      {
        type: "plugin-signal",
        pluginId: "tasks",
        channel: "updated",
        payload: { id: 1 },
      },
    ]);
  });

  it("ignores pong frames without reporting them as invalid", () => {
    const invalid: unknown[] = [];
    const { factory, realtime } = setup({
      onInvalidMessage: (error) => invalid.push(error),
    });
    const changed: unknown[] = [];
    realtime.onChanged((m) => changed.push(m));
    realtime.connect();
    factory.latest().open();
    factory.latest().receive(JSON.stringify({ type: "pong" }));
    factory.latest().receive(JSON.stringify({ type: "pong", extra: 1 }));
    expect(invalid).toEqual([]);
    expect(changed).toEqual([]);
  });

  describe("liveness probes", () => {
    it("pings an idle open socket on the interval and is satisfied by a pong", () => {
      const { factory, realtime } = setup();
      realtime.connect();
      const socket = factory.latest();
      socket.open();
      expect(socket.sentMessages()).toEqual([]);

      vi.advanceTimersByTime(REALTIME_PING_INTERVAL_MS - 1);
      expect(socket.sentMessages()).toEqual([]);
      vi.advanceTimersByTime(1);
      expect(socket.sentMessages()).toEqual([{ type: "ping" }]);

      socket.receive(JSON.stringify({ type: "pong" }));
      vi.advanceTimersByTime(REALTIME_PONG_TIMEOUT_MS);
      expect(socket.closes).toEqual([]);
      expect(factory.sockets).toHaveLength(1);
      expect(realtime.getConnectionState()).toBe("connected");

      vi.advanceTimersByTime(
        REALTIME_PING_INTERVAL_MS - REALTIME_PONG_TIMEOUT_MS,
      );
      expect(socket.sentMessages()).toEqual([
        { type: "ping" },
        { type: "ping" },
      ]);
    });

    it("skips the ping when any frame arrived recently", () => {
      const { factory, realtime } = setup();
      realtime.connect();
      const socket = factory.latest();
      socket.open();
      vi.advanceTimersByTime(REALTIME_PING_INTERVAL_MS - 1000);
      socket.receive(
        JSON.stringify({ type: "changed", entity: "system", changes: [] }),
      );
      vi.advanceTimersByTime(1000);
      expect(socket.sentMessages()).toEqual([]);
    });

    it("replaces a socket whose ping goes unanswered and watermarks from the last inbound frame", () => {
      vi.setSystemTime(1_000_000);
      const { factory, realtime } = setup();
      const events: MobileRealtimeConnectedEvent[] = [];
      realtime.onConnected((event) => events.push(event));
      realtime.subscribe(THREAD_TARGET);
      realtime.connect();
      const first = factory.latest();
      first.open();

      vi.advanceTimersByTime(10_000);
      first.receive(
        JSON.stringify({ type: "changed", entity: "system", changes: [] }),
      );
      const lastFrameAt = Date.now();

      vi.advanceTimersByTime(REALTIME_PING_INTERVAL_MS - 10_000);
      expect(first.sentMessages().at(-1)).toEqual({ type: "ping" });
      vi.advanceTimersByTime(REALTIME_PONG_TIMEOUT_MS - 1);
      expect(factory.sockets).toHaveLength(1);
      vi.advanceTimersByTime(1);
      expect(first.closes).toHaveLength(1);
      expect(factory.sockets).toHaveLength(2);
      expect(realtime.getConnectionState()).toBe("reconnecting");

      first.receive(JSON.stringify({ type: "pong" }));
      factory.latest().open();
      expect(events).toEqual([
        { reconnected: false },
        { reconnected: true, disconnectedAt: lastFrameAt },
      ]);
      expect(factory.latest().sentMessages()).toEqual([
        { type: "subscribe", target: THREAD_TARGET },
      ]);
    });

    it("reconnects immediately when the socket closes while a probe is outstanding", () => {
      const { factory, realtime } = setup();
      realtime.connect();
      const first = factory.latest();
      first.open();
      vi.advanceTimersByTime(REALTIME_PING_INTERVAL_MS);
      expect(first.sentMessages()).toEqual([{ type: "ping" }]);
      first.drop();
      expect(factory.sockets).toHaveLength(2);
    });

    it("reports the close time as the watermark for a dropped socket and the suspend time for a suspended one", () => {
      vi.setSystemTime(5_000_000);
      const { factory, realtime } = setup();
      const events: MobileRealtimeConnectedEvent[] = [];
      realtime.onConnected((event) => events.push(event));
      realtime.connect();
      factory.latest().open();

      vi.advanceTimersByTime(3_000);
      const droppedAt = Date.now();
      factory.latest().drop();
      vi.advanceTimersByTime(1_000);
      factory.latest().open();

      vi.advanceTimersByTime(2_000);
      const suspendedAt = Date.now();
      realtime.suspend();
      vi.advanceTimersByTime(60_000);
      realtime.resume();
      factory.latest().open();

      expect(events).toEqual([
        { reconnected: false },
        { reconnected: true, disconnectedAt: droppedAt },
        { reconnected: true, disconnectedAt: suspendedAt },
      ]);
    });

    it("stops pinging while suspended and resumes the loop on the new socket", () => {
      const { factory, realtime } = setup();
      realtime.connect();
      factory.latest().open();
      realtime.suspend();
      vi.advanceTimersByTime(REALTIME_PING_INTERVAL_MS * 3);
      expect(factory.sockets).toHaveLength(1);
      realtime.resume();
      const second = factory.latest();
      second.open();
      vi.advanceTimersByTime(REALTIME_PING_INTERVAL_MS);
      expect(second.sentMessages()).toEqual([{ type: "ping" }]);
    });

    it("resume() without a suspend probes an open socket and skips the backoff of a closed one", () => {
      const { factory, realtime } = setup();
      realtime.connect();
      const socket = factory.latest();
      socket.open();
      vi.advanceTimersByTime(REALTIME_PONG_TIMEOUT_MS);
      realtime.resume();
      expect(socket.sentMessages()).toEqual([{ type: "ping" }]);
      socket.receive(JSON.stringify({ type: "pong" }));
      vi.advanceTimersByTime(REALTIME_PONG_TIMEOUT_MS);
      expect(factory.sockets).toHaveLength(1);

      socket.drop();
      expect(factory.sockets).toHaveLength(1);
      vi.advanceTimersByTime(1000);
      expect(factory.sockets).toHaveLength(2);
      factory.latest().drop();
      expect(factory.sockets).toHaveLength(2);
      realtime.resume();
      expect(factory.sockets).toHaveLength(3);
      realtime.resume();
      expect(factory.sockets).toHaveLength(3);
    });
  });

  it("passes per-attempt headers to the socket factory", () => {
    let n = 0;
    const { factory, realtime } = setup({
      headers: () => ({ cookie: `s=${++n}` }),
    });
    realtime.connect();
    expect(factory.latest().options.headers).toEqual({ cookie: "s=1" });
    factory.latest().drop();
    vi.advanceTimersByTime(1000);
    expect(factory.latest().options.headers).toEqual({ cookie: "s=2" });
    expect(factory.latest().url).toBe("ws://127.0.0.1:20304/ws");
  });

  it("dispose closes the socket, drops listeners, and ignores later calls", () => {
    const { factory, realtime } = setup();
    const changed: unknown[] = [];
    realtime.onChanged((m) => changed.push(m));
    realtime.connect();
    const socket = factory.latest();
    socket.open();
    realtime.dispose();
    expect(socket.closes).toHaveLength(1);
    socket.receive(
      JSON.stringify({ type: "changed", entity: "system", changes: [] }),
    );
    realtime.connect();
    realtime.resume();
    vi.advanceTimersByTime(60_000);
    expect(factory.sockets).toHaveLength(1);
    expect(changed).toEqual([]);
  });
});
