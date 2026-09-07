import { createStore } from "jotai";
import { QueryObserver } from "@tanstack/react-query";
import type { ChangedMessage } from "@bb/domain";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fetchHostStatus: vi.fn(),
  onConnected: vi.fn(
    (
      _listener: (event: {
        reconnected: boolean;
        disconnectedAt?: number;
      }) => void,
    ) =>
      () => {},
  ),
  onChanged: vi.fn((_listener: (message: ChangedMessage) => void) => () => {}),
  fetchSdkSystemConfig: vi.fn(async (_options?: { signal?: AbortSignal }) => ({
    hostDaemonPort: 38_887,
    localHelperPorts: [38_887, 38_888],
  })),
  fetchSystemConfig: vi.fn(async () => ({
    ok: true,
    json: async () => ({
      hostDaemonPort: 38_887,
      localHelperPorts: [38_887, 38_888],
    }),
  })),
}));

vi.mock("./api-server", () => ({
  apiClient: {
    system: {
      config: {
        $get: mocks.fetchSystemConfig,
      },
    },
  },
}));

vi.mock("./api-host-daemon", () => ({
  fetchHostStatus: mocks.fetchHostStatus,
  fetchWorkspaceOpenTargets: vi.fn(async () => []),
}));

vi.mock("./sdk", () => ({
  sdk: {
    system: {
      config: mocks.fetchSdkSystemConfig,
    },
  },
}));

vi.mock("./bb-desktop", () => ({
  getBbDesktopInfo: () => null,
}));

vi.mock("./ws", () => ({
  wsManager: {
    getConnectionState: () => "connected",
    onChanged: mocks.onChanged,
    onConnected: mocks.onConnected,
  },
}));

import {
  hostDaemonPortAtom,
  localHostDaemonAccessStateAtom,
  localHostStatusAtom,
  requestLocalHostDaemonAccessAtom,
} from "./system-config-atoms";
import { appQueryClient } from "./app-query-client";
import { sdk } from "./sdk";
import { systemConfigQueryKey } from "@/hooks/queries/query-keys";
import { systemConfigQueryOptions } from "@/hooks/queries/system-queries";
import { createRealtimeCacheEffects } from "@/hooks/realtime-cache-effects";

beforeEach(() => {
  appQueryClient.clear();
  mocks.fetchHostStatus.mockReset();
  mocks.onConnected.mockClear();
  mocks.onChanged.mockClear();
  mocks.fetchSdkSystemConfig.mockReset();
  mocks.fetchSdkSystemConfig.mockResolvedValue({
    hostDaemonPort: 38_887,
    localHelperPorts: [38_887, 38_888],
  });
  mocks.fetchSystemConfig.mockClear();
  vi.stubGlobal("window", {
    location: {
      hostname: "remote.getbb.app",
      origin: "https://remote.getbb.app",
    },
  });
  vi.stubGlobal("navigator", {
    permissions: {
      query: vi.fn(async () => ({ state: "prompt" })),
    },
    userAgent: "test",
  });
});

afterEach(() => {
  appQueryClient.clear();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("local host daemon access atoms", () => {
  it("shares the system config request with the app query owner", async () => {
    const store = createStore();
    const query = appQueryClient.fetchQuery({
      queryKey: systemConfigQueryKey(),
      queryFn: ({ signal }) => sdk.system.config({ signal }),
      staleTime: 60_000,
    });

    await Promise.all([query, store.get(localHostDaemonAccessStateAtom)]);

    expect(
      mocks.fetchSdkSystemConfig.mock.calls.length +
        mocks.fetchSystemConfig.mock.calls.length,
    ).toBe(1);
  });

  it.each(["atom-first", "realtime-first"] as const)(
    "issues one config refresh when the %s listener runs first",
    async (listenerOrder) => {
      const cachedConfig = {
        hostDaemonPort: 38_887,
        localHelperPorts: [38_887, 38_888],
      };
      appQueryClient.setQueryData(systemConfigQueryKey(), cachedConfig);
      const store = createStore();
      const unsubscribeAtom = store.sub(
        localHostDaemonAccessStateAtom,
        () => {},
      );
      const observer = new QueryObserver(
        appQueryClient,
        systemConfigQueryOptions(),
      );
      const unsubscribeQuery = observer.subscribe(() => {});
      const effects = createRealtimeCacheEffects({
        queryClient: appQueryClient,
        visibility: {
          isDocumentVisible: () => true,
          subscribe: () => () => {},
        },
      });
      const requests: Array<{
        resolve: (config: typeof cachedConfig) => void;
      }> = [];
      let abortCount = 0;

      try {
        await store.get(localHostDaemonAccessStateAtom);
        expect(mocks.fetchSdkSystemConfig).not.toHaveBeenCalled();
        mocks.fetchSdkSystemConfig.mockImplementation(
          ({ signal } = {}) =>
            new Promise((resolve) => {
              requests.push({ resolve });
              signal?.addEventListener(
                "abort",
                () => {
                  abortCount += 1;
                },
                { once: true },
              );
            }),
        );
        const message = {
          type: "changed",
          entity: "system",
          changes: ["config-changed"],
        } satisfies ChangedMessage;
        const atomListener = mocks.onChanged.mock.calls.at(-1)?.[0];
        expect(atomListener).toBeDefined();
        const notifyAtom = () => atomListener?.(message);
        const notifyRealtime = () => effects.handleChanged(message);
        const [first, second] =
          listenerOrder === "atom-first"
            ? [notifyAtom, notifyRealtime]
            : [notifyRealtime, notifyAtom];

        first();
        second();
        await vi.waitFor(() => {
          expect(requests).toHaveLength(1);
        });

        expect(abortCount).toBe(0);
      } finally {
        for (const request of requests) {
          request.resolve(cachedConfig);
        }
        effects.dispose();
        unsubscribeQuery();
        unsubscribeAtom();
      }
    },
    5_000,
  );

  it("applies a config event that arrives during an older refresh", async () => {
    const olderConfig = {
      hostDaemonPort: 38_887,
      localHelperPorts: [38_887, 38_888],
    };
    const newerConfig = {
      hostDaemonPort: 39_999,
      localHelperPorts: [],
    };
    appQueryClient.setQueryData(systemConfigQueryKey(), olderConfig);
    const store = createStore();
    const unsubscribeAtom = store.sub(localHostDaemonAccessStateAtom, () => {});
    const observer = new QueryObserver(
      appQueryClient,
      systemConfigQueryOptions(),
    );
    const unsubscribeQuery = observer.subscribe(() => {});
    const effects = createRealtimeCacheEffects({
      queryClient: appQueryClient,
      visibility: {
        isDocumentVisible: () => true,
        subscribe: () => () => {},
      },
    });
    const requests: Array<{
      resolve: (config: typeof olderConfig) => void;
    }> = [];

    try {
      await store.get(localHostDaemonAccessStateAtom);
      mocks.fetchSdkSystemConfig.mockImplementation(
        () =>
          new Promise((resolve) => {
            requests.push({ resolve });
          }),
      );
      const message = {
        type: "changed",
        entity: "system",
        changes: ["config-changed"],
      } satisfies ChangedMessage;
      const atomListener = mocks.onChanged.mock.calls.at(-1)?.[0];
      expect(atomListener).toBeDefined();
      const notify = () => {
        atomListener?.(message);
        effects.handleChanged(message);
      };

      notify();
      await vi.waitFor(() => {
        expect(requests).toHaveLength(1);
      });
      notify();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(requests).toHaveLength(1);

      requests[0]?.resolve(olderConfig);
      await vi.waitFor(() => {
        expect(requests).toHaveLength(2);
      });
      requests[1]?.resolve(newerConfig);

      await vi.waitFor(async () => {
        await expect(store.get(localHostDaemonAccessStateAtom)).resolves.toBe(
          "unavailable",
        );
      });
    } finally {
      for (const request of requests) {
        request.resolve(newerConfig);
      }
      effects.dispose();
      unsubscribeQuery();
      unsubscribeAtom();
    }
  });

  it("does not restart status discovery on the initial server connection", async () => {
    vi.stubGlobal("navigator", {
      permissions: {
        query: vi.fn(async () => ({ state: "granted" })),
      },
      userAgent: "test",
    });
    mocks.fetchHostStatus.mockResolvedValue({
      connected: true,
      hostId: "host-local",
      serverUrl: "https://remote.getbb.app",
    });
    const store = createStore();
    const unsubscribe = store.sub(localHostStatusAtom, () => {});

    await expect(store.get(localHostStatusAtom)).resolves.toMatchObject({
      hostId: "host-local",
    });
    for (const [listener] of mocks.onConnected.mock.calls) {
      listener({ reconnected: false });
    }
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mocks.fetchHostStatus).toHaveBeenCalledTimes(2);
    unsubscribe();
  });

  it("refreshes status discovery after a server reconnection", async () => {
    vi.stubGlobal("navigator", {
      permissions: {
        query: vi.fn(async () => ({ state: "granted" })),
      },
      userAgent: "test",
    });
    mocks.fetchHostStatus.mockResolvedValue({
      connected: true,
      hostId: "host-local",
      serverUrl: "https://remote.getbb.app",
    });
    const store = createStore();
    const unsubscribe = store.sub(localHostStatusAtom, () => {});

    await expect(store.get(localHostStatusAtom)).resolves.toMatchObject({
      hostId: "host-local",
    });
    for (const [listener] of mocks.onConnected.mock.calls) {
      listener({ reconnected: true, disconnectedAt: Date.now() });
    }

    await vi.waitFor(() => {
      expect(mocks.fetchHostStatus).toHaveBeenCalledTimes(4);
    });
    unsubscribe();
  });

  it("does not probe loopback while a remote page is in prompt state", async () => {
    const store = createStore();

    await expect(store.get(localHostDaemonAccessStateAtom)).resolves.toBe(
      "permission-required",
    );
    await expect(store.get(localHostStatusAtom)).resolves.toBeNull();
    expect(mocks.fetchHostStatus).not.toHaveBeenCalled();
  });

  it("probes every advertised helper port when access is explicitly requested", async () => {
    mocks.fetchHostStatus.mockResolvedValue(null);
    const store = createStore();

    await expect(store.set(requestLocalHostDaemonAccessAtom)).resolves.toBe(
      false,
    );
    expect(mocks.fetchHostStatus.mock.calls).toEqual([[38_887], [38_888]]);
  });

  it("keeps successful explicit access when permission queries are unsupported", async () => {
    vi.stubGlobal("navigator", {
      permissions: {
        query: vi.fn(async () => {
          throw new TypeError("unsupported permission");
        }),
      },
      userAgent: "test",
    });
    mocks.fetchHostStatus.mockResolvedValue({
      connected: true,
      hostId: "host-local",
      serverUrl: "https://remote.getbb.app",
    });
    const store = createStore();

    await expect(store.get(localHostDaemonAccessStateAtom)).resolves.toBe(
      "unsupported",
    );
    await expect(store.set(requestLocalHostDaemonAccessAtom)).resolves.toBe(
      true,
    );
    await expect(store.get(localHostDaemonAccessStateAtom)).resolves.toBe(
      "available",
    );
  });

  it("prefers the helper enrolled with the server serving the browser", async () => {
    mocks.fetchHostStatus.mockImplementation(async (port: number) => ({
      connected: true,
      hostId: port === 38_888 ? "host-browser-machine" : "host-primary",
      serverUrl:
        port === 38_888 ? "https://remote.getbb.app" : "http://127.0.0.1:38886",
    }));
    const store = createStore();

    await expect(store.set(requestLocalHostDaemonAccessAtom)).resolves.toBe(
      true,
    );
    await expect(store.get(hostDaemonPortAtom)).resolves.toBe(38_888);
    await expect(store.get(localHostStatusAtom)).resolves.toMatchObject({
      hostId: "host-browser-machine",
    });
  });

  it("retries unreachable helpers twice at one-second intervals", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("navigator", {
      permissions: {
        query: vi.fn(async () => ({ state: "granted" })),
      },
      userAgent: "test",
    });
    mocks.fetchHostStatus.mockResolvedValue(null);
    const store = createStore();

    const status = store.get(localHostStatusAtom);
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.fetchHostStatus).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(999);
    expect(mocks.fetchHostStatus).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(mocks.fetchHostStatus).toHaveBeenCalledTimes(4);

    await vi.advanceTimersByTimeAsync(1_000);
    await expect(status).resolves.toBeNull();
    expect(mocks.fetchHostStatus).toHaveBeenCalledTimes(6);
  });
});
