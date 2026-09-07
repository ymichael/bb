import type { DesktopSession } from "@bb/connect-client";
import { QueryObserver } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ConnectServerProfile,
  DirectServerProfile,
} from "../profiles/profile";
import type { AppStateLike, AppStateStatusLike } from "../realtime/app-state";
import {
  createFakeSocketFactory,
  type FakeSocket,
} from "../realtime/fake-socket";
import type { RealtimeSocketFactory } from "../realtime/socket";
import { createProfileClientRegistry } from "../sdk/client-registry";
import { createSessionScheduler } from "../session/session-scheduler";
import {
  AUTH_FAILURE_BREAKER_COOLDOWN_MS,
  AUTH_FAILURE_MAX_REMINTS,
  AUTH_FAILURE_REFETCH_DELAY_MS,
  AUTH_FAILURE_STREAK_WINDOW_MS,
  AUTH_FAILURE_VERIFY_DEBOUNCE_MS,
  CONNECT_FAILURE_VERIFY_INTERVAL_MS,
  createActiveProfileConnector,
} from "./active-profile-connector";

const direct: DirectServerProfile = {
  id: "d1",
  mode: "direct",
  serverUrl: "http://127.0.0.1:41999",
  label: "Simulator",
  createdAt: 0,
};

const connect: ConnectServerProfile = {
  id: "c1",
  mode: "connect",
  serverUrl: "https://bee.getbb.app",
  label: "bee",
  handle: "bee",
  credential: "bbcm_one",
  createdAt: 0,
};

function fakeAppState(): AppStateLike & {
  emit(state: AppStateStatusLike): void;
} {
  const handlers = new Set<(state: AppStateStatusLike) => void>();
  return {
    currentState: "active",
    addEventListener(_type, handler) {
      handlers.add(handler);
      return {
        remove: () => {
          handlers.delete(handler);
        },
      };
    },
    emit(state) {
      for (const handler of handlers) handler(state);
    },
  };
}

interface SetupOptions {
  fallbackResponse?: () => Response;
  onSocket?: (socket: FakeSocket) => void;
}

function setup(options: SetupOptions = {}) {
  const sockets = createFakeSocketFactory();
  const socketFactory: RealtimeSocketFactory = (url, socketOptions) => {
    const socket = sockets(url, socketOptions);
    options.onSocket?.(sockets.latest());
    return socket;
  };
  const fetchResponses: Response[] = [];
  const fetchCalls = { count: 0 };
  const registry = createProfileClientRegistry({
    sdk: {
      fetch: async () => {
        fetchCalls.count += 1;
        const next = fetchResponses.shift() ?? options.fallbackResponse?.();
        if (!next) throw new TypeError("Network request failed");
        return next;
      },
      realtime: { socketFactory, onInvalidMessage: () => {} },
    },
  });
  const appState = fakeAppState();
  const fetchSession = vi.fn<() => Promise<DesktopSession>>();
  const schedulers: ReturnType<typeof createSessionScheduler>[] = [];
  const connector = createActiveProfileConnector({
    registry,
    appState,
    createSessionScheduler: () => {
      const scheduler = createSessionScheduler({
        cookieStore: { set: async () => true },
        fetchSession,
      });
      schedulers.push(scheduler);
      return scheduler;
    },
  });
  const changes: string[] = [];
  connector.subscribe(() => {
    const snap = connector.getSnapshot();
    changes.push(snap ? `${snap.profile.id}:${snap.session.status}` : "none");
  });
  return {
    sockets,
    registry,
    appState,
    fetchSession,
    fetchResponses,
    fetchCalls,
    schedulers,
    connector,
  };
}

function signInPage(): Response {
  return new Response("<html>sign in</html>", {
    status: 401,
    headers: { "content-type": "text/html" },
  });
}

function sessionCookie(value: string): DesktopSession {
  return {
    cookie: {
      name: "bb_desktop_session",
      value,
      domain: ".getbb.app",
      expiresAt: Date.now() + 3_600_000,
    },
  };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 4; i += 1) await Promise.resolve();
}

async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

describe("createActiveProfileConnector", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("opens the socket immediately for a direct profile and reuses the client on re-activation", () => {
    const { sockets, registry, connector } = setup();
    connector.activate(direct);
    expect(sockets.sockets).toHaveLength(1);
    const snap = connector.getSnapshot();
    expect(snap?.client).toBe(registry.peekClient(direct.id));
    expect(snap?.session).toEqual({ status: "idle" });

    connector.activate({ ...direct, label: "Renamed" });
    expect(sockets.sockets).toHaveLength(1);
    expect(connector.getSnapshot()?.profile.label).toBe("Renamed");
    expect(connector.getSnapshot()?.client).toBe(snap?.client);
  });

  it("tears the previous socket down when switching profiles and when deactivating", () => {
    const { sockets, connector } = setup();
    connector.activate(direct);
    const first = sockets.latest();
    first.open();

    connector.activate({ ...direct, id: "d2", serverUrl: "http://10.0.0.5:1" });
    expect(first.closes).toHaveLength(1);
    expect(sockets.sockets).toHaveLength(2);
    expect(sockets.latest().url).toBe("ws://10.0.0.5:1/ws");

    connector.activate(null);
    expect(sockets.latest().closes).toHaveLength(1);
    expect(connector.getSnapshot()).toBeNull();
  });

  it("suspends and resumes the live socket with AppState", () => {
    const { sockets, appState, connector } = setup();
    connector.activate(direct);
    sockets.latest().open();
    appState.emit("background");
    expect(sockets.latest().closes).toHaveLength(1);
    appState.emit("active");
    expect(sockets.sockets).toHaveLength(2);

    connector.activate(null);
    appState.emit("active");
    expect(sockets.sockets).toHaveLength(2);
  });

  it("opens the socket for a connect profile only once the session is installed", async () => {
    const { sockets, fetchSession, connector } = setup();
    let resolveSession: (session: DesktopSession) => void = () => {};
    fetchSession.mockImplementation(
      () =>
        new Promise<DesktopSession>((resolve) => {
          resolveSession = resolve;
        }),
    );
    connector.activate(connect);
    await flush();
    expect(connector.getSnapshot()?.session.status).toBe("authenticating");
    expect(sockets.sockets).toHaveLength(0);

    resolveSession({
      cookie: {
        name: "bb_desktop_session",
        value: "s",
        domain: ".getbb.app",
        expiresAt: Date.now() + 3_600_000,
      },
    });
    await flush();
    expect(connector.getSnapshot()?.session.status).toBe("authenticated");
    expect(sockets.sockets).toHaveLength(1);
    expect(sockets.latest().url).toBe("wss://bee.getbb.app/ws");
  });

  it("closes the socket and stops when the credential is rejected, and rebuilds on a new credential", async () => {
    const { sockets, fetchSession, schedulers, connector } = setup();
    fetchSession.mockResolvedValueOnce({
      cookie: {
        name: "bb_desktop_session",
        value: "s",
        domain: ".getbb.app",
        expiresAt: Date.now() + 3_600_000,
      },
    });
    connector.activate(connect);
    await flush();
    sockets.latest().open();

    fetchSession.mockRejectedValueOnce(
      Object.assign(new Error("unauthorized"), { status: 401 }),
    );
    await schedulers[0]?.renewNow();
    await flush();
    expect(connector.getSnapshot()?.session.status).toBe("auth-required");
    expect(sockets.latest().closes).toHaveLength(1);
    expect(sockets.sockets).toHaveLength(1);

    fetchSession.mockResolvedValueOnce({
      cookie: {
        name: "bb_desktop_session",
        value: "s2",
        domain: ".getbb.app",
        expiresAt: Date.now() + 3_600_000,
      },
    });
    connector.activate({ ...connect, credential: "bbcm_two" });
    await flush();
    expect(schedulers).toHaveLength(2);
    expect(schedulers[0]?.getState()).toEqual({ status: "idle" });
    expect(connector.getSnapshot()?.session.status).toBe("authenticated");
    expect(sockets.sockets).toHaveLength(2);
  });

  it("re-mints the session when the gate refuses the /ws upgrade and reconnects at once; a refused re-mint ends in auth-required", async () => {
    const { sockets, fetchSession, connector } = setup();
    fetchSession.mockResolvedValueOnce(sessionCookie("s1"));
    connector.activate(connect);
    await flush();
    sockets.latest().open();
    expect(fetchSession).toHaveBeenCalledTimes(1);

    fetchSession.mockResolvedValueOnce(sessionCookie("s2"));
    vi.advanceTimersByTime(AUTH_FAILURE_VERIFY_DEBOUNCE_MS);
    sockets.latest().drop();
    vi.advanceTimersByTime(1000);
    expect(sockets.sockets).toHaveLength(2);
    sockets.latest().reject("Received bad response code from server 401");
    await settle();
    expect(fetchSession).toHaveBeenCalledTimes(2);
    expect(connector.getSnapshot()?.session.status).toBe("authenticated");
    expect(sockets.sockets).toHaveLength(3);
    sockets.latest().open();

    fetchSession.mockRejectedValueOnce(
      Object.assign(new Error("unauthorized"), { status: 401 }),
    );
    sockets.latest().drop();
    vi.advanceTimersByTime(1000);
    vi.advanceTimersByTime(2000);
    sockets.latest().reject("Received bad response code from server 401");
    await settle();
    expect(connector.getSnapshot()?.session.status).toBe("auth-required");
    expect(fetchSession).toHaveBeenCalledTimes(3);
    vi.advanceTimersByTime(60_000);
    expect(sockets.sockets).toHaveLength(4);
  });

  it("verifies the session on a 401 from an API call and throttles plain connection failures", async () => {
    const { sockets, fetchSession, fetchResponses, connector, registry } =
      setup();
    fetchSession.mockResolvedValueOnce(sessionCookie("s1"));
    connector.activate(connect);
    await flush();
    sockets.latest().open();

    vi.advanceTimersByTime(AUTH_FAILURE_VERIFY_DEBOUNCE_MS);
    fetchSession.mockResolvedValueOnce(sessionCookie("s2"));
    fetchResponses.push(
      new Response("<html>sign in</html>", {
        status: 401,
        headers: { "content-type": "text/html" },
      }),
    );
    const client = registry.peekClient(connect.id);
    await expect(client?.sdk.system.config()).rejects.toMatchObject({
      status: 401,
    });
    await settle();
    expect(fetchSession).toHaveBeenCalledTimes(2);
    expect(sockets.sockets).toHaveLength(1);

    fetchSession.mockResolvedValue(sessionCookie("s3"));
    vi.advanceTimersByTime(CONNECT_FAILURE_VERIFY_INTERVAL_MS);
    sockets.latest().drop();
    vi.advanceTimersByTime(1000);
    sockets.latest().drop();
    await settle();
    expect(fetchSession).toHaveBeenCalledTimes(3);
    sockets.latest().drop();
    vi.advanceTimersByTime(1500);
    sockets.latest().drop();
    await settle();
    expect(fetchSession).toHaveBeenCalledTimes(3);
    vi.advanceTimersByTime(CONNECT_FAILURE_VERIFY_INTERVAL_MS);
    sockets.latest().drop();
    await settle();
    expect(fetchSession).toHaveBeenCalledTimes(4);

    connector.activate(direct);
    expect(fetchSession).toHaveBeenCalledTimes(4);
  });

  it("refetches queries that raced the first mint once the cookie is installed, without minting again", async () => {
    const { sockets, fetchSession, fetchResponses, connector, registry } =
      setup();
    let resolveSession: (session: DesktopSession) => void = () => {};
    fetchSession.mockImplementation(
      () =>
        new Promise<DesktopSession>((resolve) => {
          resolveSession = resolve;
        }),
    );
    connector.activate(connect);
    await flush();
    const client = registry.peekClient(connect.id);
    if (!client) throw new Error("client missing");

    fetchResponses.push(
      new Response("<html>sign in</html>", {
        status: 401,
        headers: { "content-type": "text/html" },
      }),
    );
    const observer = new QueryObserver(client.queryClient, {
      queryKey: ["system-config"],
      queryFn: () => client.sdk.system.config(),
    });
    const results: string[] = [];
    const unsubscribe = observer.subscribe((result) => {
      results.push(result.status);
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(observer.getCurrentResult().status).toBe("error");
    expect(fetchSession).toHaveBeenCalledTimes(1);

    fetchResponses.push(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    resolveSession(sessionCookie("s1"));
    await flush();
    expect(connector.getSnapshot()?.session.status).toBe("authenticated");
    await vi.advanceTimersByTimeAsync(0);
    expect(observer.getCurrentResult().status).toBe("success");
    expect(fetchSession).toHaveBeenCalledTimes(1);
    expect(sockets.sockets).toHaveLength(1);
    unsubscribe();
  });

  it("blames a 401 right after a mint on the stale cookie: refetches instead of minting again", async () => {
    const { fetchSession, fetchResponses, connector, registry } = setup();
    fetchSession.mockResolvedValueOnce(sessionCookie("s1"));
    connector.activate(connect);
    await flush();
    const client = registry.peekClient(connect.id);
    if (!client) throw new Error("client missing");
    expect(fetchSession).toHaveBeenCalledTimes(1);

    fetchResponses.push(
      new Response("<html>sign in</html>", {
        status: 401,
        headers: { "content-type": "text/html" },
      }),
    );
    const observer = new QueryObserver(client.queryClient, {
      queryKey: ["system-config"],
      queryFn: () => client.sdk.system.config(),
    });
    const unsubscribe = observer.subscribe(() => {});
    await vi.advanceTimersByTimeAsync(0);
    expect(observer.getCurrentResult().status).toBe("error");
    expect(fetchSession).toHaveBeenCalledTimes(1);

    fetchResponses.push(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    await vi.advanceTimersByTimeAsync(AUTH_FAILURE_REFETCH_DELAY_MS);
    expect(observer.getCurrentResult().status).toBe("success");
    expect(fetchSession).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it("stops re-minting after a few cycles when the gate keeps refusing freshly minted sessions, reports an error, and recovers after the cooldown", async () => {
    let gateRefuses = true;
    const { sockets, fetchSession, fetchCalls, connector, registry } = setup({
      fallbackResponse: () =>
        gateRefuses
          ? signInPage()
          : new Response(JSON.stringify({ ok: true }), {
              status: 200,
              headers: { "content-type": "application/json" },
            }),
      onSocket: (socket) => {
        setTimeout(() => {
          if (gateRefuses) {
            socket.reject("Received bad response code from server 401");
          } else {
            socket.open();
          }
        }, 0);
      },
    });
    fetchSession.mockImplementation(
      () =>
        new Promise<DesktopSession>((resolve) => {
          setTimeout(() => resolve(sessionCookie("s")), 300);
        }),
    );
    connector.activate(connect);
    const client = registry.peekClient(connect.id);
    if (!client) throw new Error("client missing");
    const observer = new QueryObserver(client.queryClient, {
      queryKey: ["system-config"],
      queryFn: () => client.sdk.system.config(),
    });
    const unsubscribe = observer.subscribe(() => {});

    await vi.advanceTimersByTimeAsync(AUTH_FAILURE_BREAKER_COOLDOWN_MS);
    expect(fetchSession.mock.calls.length).toBeGreaterThan(1);
    expect(fetchSession.mock.calls.length).toBeLessThanOrEqual(
      1 + AUTH_FAILURE_MAX_REMINTS,
    );
    expect(fetchCalls.count).toBeLessThan(60);
    const tripped = connector.getSnapshot()?.session;
    expect(tripped?.status).toBe("error");
    if (tripped?.status !== "error") throw new Error("unreachable");
    expect(tripped.retryAt).toBeGreaterThan(Date.now());
    expect(observer.getCurrentResult().status).toBe("error");
    const mintsWhileTripped = fetchSession.mock.calls.length;
    const fetchesWhileTripped = fetchCalls.count;

    gateRefuses = false;
    await vi.advanceTimersByTimeAsync(tripped.retryAt - Date.now());
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchSession.mock.calls.length).toBe(mintsWhileTripped + 1);
    expect(fetchCalls.count).toBeGreaterThan(fetchesWhileTripped);
    expect(connector.getSnapshot()?.session.status).toBe("authenticated");
    expect(observer.getCurrentResult().status).toBe("success");
    expect(sockets.latest().readyState).toBe(1);
    unsubscribe();
  });

  it("keeps re-minting for auth failures spaced out in time: the streak only counts failures that follow a mint closely", async () => {
    const { fetchSession, fetchResponses, connector, registry } = setup();
    fetchSession.mockResolvedValue(sessionCookie("s"));
    connector.activate(connect);
    await flush();
    const client = registry.peekClient(connect.id);
    if (!client) throw new Error("client missing");
    expect(fetchSession).toHaveBeenCalledTimes(1);

    for (let i = 0; i < AUTH_FAILURE_MAX_REMINTS + 2; i += 1) {
      vi.advanceTimersByTime(AUTH_FAILURE_STREAK_WINDOW_MS);
      fetchResponses.push(signInPage());
      await expect(client.sdk.system.config()).rejects.toMatchObject({
        status: 401,
      });
      await settle();
      expect(fetchSession).toHaveBeenCalledTimes(i + 2);
      expect(connector.getSnapshot()?.session.status).toBe("authenticated");
    }
  });

  it("ignores late session events from a profile the user already left", async () => {
    const { sockets, fetchSession, connector } = setup();
    let resolveSession: (session: DesktopSession) => void = () => {};
    fetchSession.mockImplementation(
      () =>
        new Promise<DesktopSession>((resolve) => {
          resolveSession = resolve;
        }),
    );
    connector.activate(connect);
    await flush();
    connector.activate(direct);
    expect(sockets.sockets).toHaveLength(1);

    resolveSession({
      cookie: {
        name: "bb_desktop_session",
        value: "s",
        domain: ".getbb.app",
        expiresAt: Date.now() + 3_600_000,
      },
    });
    await flush();
    expect(sockets.sockets).toHaveLength(1);
    expect(connector.getSnapshot()?.profile.id).toBe(direct.id);
    expect(connector.getSnapshot()?.session).toEqual({ status: "idle" });
  });
});
