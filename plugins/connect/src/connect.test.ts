import { createServer, type Server } from "node:http";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket as NodeWebSocket, WebSocketServer } from "ws";
import {
  createFakePluginHost,
  type FakePluginHost,
} from "@get-bb/plugin-sdk/testing";
import { decodeFrame, encodeFrame, type Frame } from "@bb/tunnel-contract";
import {
  headersForLoopbackRequest,
  isBareBbRealtimeWs,
  TunnelSession,
} from "@bb/tunnel-client";
import { deriveConnectBaseUrl, serverUrlForHandle } from "@bb/connect-client";
import {
  parseSharePort,
  machineSharePublicUrl,
  SharePortError,
  ShareRegistry,
  sharePublicUrl,
  SHARES_KV_KEY,
  serverOwnPort,
} from "./shares.js";
import { CREDENTIAL_KV_KEY } from "./credential.js";
import plugin from "./server.js";
import { ConnectTunnel } from "./tunnel.js";
import {
  DEFAULT_CONNECT_BASE_URL,
  resolveDefaultConnectBaseUrl,
} from "./redeem.js";
import type { ConnectStatus } from "./types.js";
import { ShareHostResolver } from "./hosts.js";

const SERVER_HOST_ID = "host-server";
const SERVER_HOST_NAME = "Server";
const REMOTE_HOST_ID = "host-air";
const REMOTE_HOST_NAME = "Sawyer Air";

function createConnectFakeHost(options?: {
  remoteIdentity?: { label: string; baseDomain: string };
  mobileApp?: boolean;
}): FakePluginHost {
  return createFakePluginHost({
    pluginId: "connect",
    sdk: {
      system: {
        config: async () =>
          ({
            primaryHostId: SERVER_HOST_ID,
            experiments: { mobileApp: options?.mobileApp ?? true },
          }) as never,
      },
      hosts: {
        get: async ({ hostId }: { hostId: string }) => {
          const host =
            hostId === SERVER_HOST_ID
              ? { id: SERVER_HOST_ID, name: SERVER_HOST_NAME }
              : hostId === REMOTE_HOST_ID
                ? { id: REMOTE_HOST_ID, name: REMOTE_HOST_NAME }
                : null;
          if (!host) {
            throw Object.assign(new Error(`host ${hostId} not found`), {
              status: 404,
            });
          }
          return host as never;
        },
        list: async () =>
          [
            { id: SERVER_HOST_ID, name: SERVER_HOST_NAME },
            { id: REMOTE_HOST_ID, name: REMOTE_HOST_NAME },
          ] as never,
      },
    },
    ...(options?.remoteIdentity
      ? {
          sharedPortTunnelIdentities: {
            [REMOTE_HOST_ID]: options.remoteIdentity,
          },
        }
      : {}),
  });
}

describe("deriveConnectBaseUrl", () => {
  it("drops the handle label to reach the apex", () => {
    expect(deriveConnectBaseUrl("https://sawyer.getbb.app")).toBe(
      "https://getbb.app",
    );
    expect(deriveConnectBaseUrl("https://my-box.vibecodethis.site/")).toBe(
      "https://vibecodethis.site",
    );
  });
});

describe("resolveDefaultConnectBaseUrl", () => {
  it("uses the local Cloud origin only in development", () => {
    expect(
      resolveDefaultConnectBaseUrl({
        NODE_ENV: "development",
        BB_DEV_CONNECT_BASE_URL: "http://bb.localhost:42745/",
      }),
    ).toBe("http://bb.localhost:42745");
    expect(
      resolveDefaultConnectBaseUrl({
        NODE_ENV: "production",
        BB_DEV_CONNECT_BASE_URL: "http://bb.localhost:42745",
      }),
    ).toBe(DEFAULT_CONNECT_BASE_URL);
    expect(resolveDefaultConnectBaseUrl({ NODE_ENV: "development" })).toBe(
      DEFAULT_CONNECT_BASE_URL,
    );
  });

  it("rejects non-local or non-origin development values", () => {
    for (const value of [
      "https://bb.localhost:42745",
      "http://getbb.app:42745",
      "http://bb.localhost:42745/dashboard",
      "not a url",
    ]) {
      expect(() =>
        resolveDefaultConnectBaseUrl({
          NODE_ENV: "development",
          BB_DEV_CONNECT_BASE_URL: value,
        }),
      ).toThrow(
        "BB_DEV_CONNECT_BASE_URL must be an http://bb.localhost:<port> origin",
      );
    }
  });
});

describe("serverUrlForHandle", () => {
  it("prepends the handle label to the apex", () => {
    expect(serverUrlForHandle("https://getbb.app", "sawyer")).toBe(
      "https://sawyer.getbb.app",
    );
  });
});

describe("headersForLoopbackRequest", () => {
  it("rewrites the paired connect origin to the loopback app origin only", () => {
    expect(
      headersForLoopbackRequest(
        [
          ["Origin", "https://sawyer.getbb.app"],
          ["Content-Type", "application/json"],
          ["Host", "sawyer.getbb.app"],
        ],
        {
          publicOrigin: "https://sawyer.getbb.app",
          loopbackOrigin: "http://127.0.0.1:38886",
        },
      ),
    ).toEqual({
      Origin: "http://127.0.0.1:38886",
      "Content-Type": "application/json",
    });

    expect(
      headersForLoopbackRequest([["Origin", "https://evil.example"]], {
        publicOrigin: "https://sawyer.getbb.app",
        loopbackOrigin: "http://127.0.0.1:38886",
      }),
    ).toEqual({ Origin: "https://evil.example" });
  });

  it("injects Host and rewrites share Origin for share streams", () => {
    expect(
      headersForLoopbackRequest(
        [
          ["Origin", "https://sawyer--8000.getbb.app"],
          ["Content-Type", "text/plain"],
          ["Host", "sawyer--8000.getbb.app"],
        ],
        {
          publicOrigin: "https://sawyer--8000.getbb.app",
          loopbackOrigin: "http://127.0.0.1:8000",
          host: "127.0.0.1:8000",
        },
      ),
    ).toEqual({
      Origin: "http://127.0.0.1:8000",
      "Content-Type": "text/plain",
      Host: "127.0.0.1:8000",
    });
  });
});

describe("sharePublicUrl", () => {
  it("builds https://handle--port.base from the credential serverUrl", () => {
    expect(
      sharePublicUrl(
        { serverUrl: "https://sawyer.getbb.app", handle: "sawyer" },
        8000,
      ),
    ).toBe("https://sawyer--8000.getbb.app");
  });

  it("uses a non-primary routing label when multi-server pairing stored one", () => {
    expect(
      sharePublicUrl(
        {
          serverUrl: "https://sawyer-desktop.getbb.app",
          handle: "sawyer-desktop",
        },
        8000,
      ),
    ).toBe("https://sawyer-desktop--8000.getbb.app");
  });

  it("uses HTTP and the local port for machine shares in local Cloud", () => {
    expect(
      machineSharePublicUrl(
        { label: "sawyer-air", baseDomain: "bb.localhost:42745" },
        8000,
      ),
    ).toBe("http://sawyer-air--8000.bb.localhost:42745");
  });
});

describe("parseSharePort / serverOwnPort", () => {
  it("accepts integers 1–65535 and rejects the rest", () => {
    expect(parseSharePort(80)).toBe(80);
    expect(parseSharePort("5173")).toBe(5173);
    expect(() => parseSharePort(0)).toThrow(SharePortError);
    expect(() => parseSharePort(65536)).toThrow(SharePortError);
    expect(() => parseSharePort(3.5)).toThrow(SharePortError);
    expect(() => parseSharePort("nope")).toThrow(SharePortError);
  });

  it("reads the bb server port from the loopback base URL", () => {
    expect(serverOwnPort("http://127.0.0.1:38886")).toBe(38886);
    expect(serverOwnPort("http://127.0.0.1")).toBe(80);
  });
});

describe("ShareRegistry", () => {
  it("persists shares in kv and refuses the server's own port", async () => {
    const kv = new Map<string, unknown>();
    const store = {
      async get<T>(key: string) {
        return kv.get(key) as T | undefined;
      },
      async set(key: string, value: unknown) {
        kv.set(key, value);
      },
      async delete(key: string) {
        kv.delete(key);
      },
    };
    const credential = {
      serverUrl: "https://sawyer.getbb.app",
      handle: "sawyer",
      credential: "bbcred_x",
    };
    const fakeHost = createFakePluginHost({
      sdk: {
        system: {
          config: async () => ({ primaryHostId: "host-server" }) as never,
        },
        hosts: {
          get: async () => ({ id: "host-server", name: "Server" }) as never,
        },
      },
    });
    const pluginBb = fakeHost.bb as unknown as Parameters<typeof plugin>[0];
    const hostResolver = new ShareHostResolver(() => pluginBb.sdk);
    const serverHost = {
      id: "host-server",
      name: "Server",
      isServer: true,
    };
    const registry = new ShareRegistry({
      kv: store,
      hosts: pluginBb.hosts,
      hostResolver,
      getLoopbackBaseUrl: () => "http://127.0.0.1:38886",
      getCredential: () => credential,
      log: pluginBb.log,
    });
    await registry.load();

    await expect(registry.add(38886, serverHost)).rejects.toThrow(/own port/);

    const added = await registry.add(8000, serverHost);
    expect(added.url).toBe("https://sawyer--8000.getbb.app");
    expect(registry.hasServerPort(8000)).toBe(true);
    expect(kv.get(SHARES_KV_KEY)).toMatchObject({
      "host-server:8000": { hostId: "host-server", port: 8000 },
    });

    const reloaded = new ShareRegistry({
      kv: store,
      hosts: pluginBb.hosts,
      hostResolver,
      getLoopbackBaseUrl: () => "http://127.0.0.1:38886",
      getCredential: () => credential,
      log: pluginBb.log,
    });
    await reloaded.load();
    expect(await reloaded.list()).toEqual([
      {
        hostId: "host-server",
        hostName: "Server",
        port: 8000,
        url: "https://sawyer--8000.getbb.app",
        createdAt: expect.any(Number),
      },
    ]);

    expect(await reloaded.remove(8000, "host-server")).toMatchObject({
      removed: true,
      hostId: "host-server",
    });
    expect(await reloaded.remove(8000, "host-server")).toMatchObject({
      removed: false,
      hostId: "host-server",
    });
    expect(kv.has(SHARES_KV_KEY)).toBe(false);
    await fakeHost.harness.dispose();
  });

  it("loads legacy entries without hostId as server-host shares", async () => {
    const kv = new Map<string, unknown>([
      [SHARES_KV_KEY, { "3000": { port: 3000, createdAt: 123 } }],
    ]);
    const fakeHost = createConnectFakeHost();
    const pluginBb = fakeHost.bb as unknown as Parameters<typeof plugin>[0];
    const registry = new ShareRegistry({
      kv: {
        async get<T>(key: string) {
          return kv.get(key) as T | undefined;
        },
        async set(key: string, value: unknown) {
          kv.set(key, value);
        },
        async delete(key: string) {
          kv.delete(key);
        },
      },
      hosts: pluginBb.hosts,
      hostResolver: new ShareHostResolver(() => pluginBb.sdk),
      getLoopbackBaseUrl: () => "http://127.0.0.1:38886",
      getCredential: () => ({
        serverUrl: "https://sawyer.getbb.app",
        handle: "sawyer",
        credential: "bbcred_x",
      }),
      log: pluginBb.log,
    });

    await registry.load();
    expect(await registry.list()).toEqual([
      {
        hostId: SERVER_HOST_ID,
        hostName: SERVER_HOST_NAME,
        port: 3000,
        createdAt: 123,
        url: "https://sawyer--3000.getbb.app",
      },
    ]);
    expect(kv.get(SHARES_KV_KEY)).toEqual({
      "3000": { port: 3000, createdAt: 123 },
    });
    await fakeHost.harness.dispose();
  });

  it("lists persisted shares in the sync snapshot before any resolution, including unpaired", async () => {
    const kv = new Map<string, unknown>([
      [
        SHARES_KV_KEY,
        {
          "3000": { port: 3000, createdAt: 1 },
          [`${REMOTE_HOST_ID}:4000`]: {
            hostId: REMOTE_HOST_ID,
            port: 4000,
            createdAt: 2,
          },
        },
      ],
    ]);
    const fakeHost = createConnectFakeHost();
    const pluginBb = fakeHost.bb as unknown as Parameters<typeof plugin>[0];
    const registry = new ShareRegistry({
      kv: {
        async get<T>(key: string) {
          return kv.get(key) as T | undefined;
        },
        async set(key: string, value: unknown) {
          kv.set(key, value);
        },
        async delete(key: string) {
          kv.delete(key);
        },
      },
      hosts: pluginBb.hosts,
      hostResolver: new ShareHostResolver(() => pluginBb.sdk),
      getLoopbackBaseUrl: () => "http://127.0.0.1:38886",
      getCredential: () => null,
      log: pluginBb.log,
    });

    await registry.load();
    expect(registry.snapshot()).toEqual([
      {
        hostId: REMOTE_HOST_ID,
        hostName: REMOTE_HOST_ID,
        port: 4000,
        createdAt: 2,
        url: "",
        unavailableReason: "Share URL has not been resolved yet.",
      },
      {
        hostId: "server",
        hostName: "server host",
        port: 3000,
        createdAt: 1,
        url: "",
        unavailableReason: "Share URL has not been resolved yet.",
      },
    ]);
    await fakeHost.harness.dispose();
  });

  it("collapses the placeholder snapshot row when a legacy share resolves", async () => {
    const kv = new Map<string, unknown>([
      [SHARES_KV_KEY, { "3000": { port: 3000, createdAt: 123 } }],
    ]);
    const fakeHost = createConnectFakeHost();
    const pluginBb = fakeHost.bb as unknown as Parameters<typeof plugin>[0];
    const registry = new ShareRegistry({
      kv: {
        async get<T>(key: string) {
          return kv.get(key) as T | undefined;
        },
        async set(key: string, value: unknown) {
          kv.set(key, value);
        },
        async delete(key: string) {
          kv.delete(key);
        },
      },
      hosts: pluginBb.hosts,
      hostResolver: new ShareHostResolver(() => pluginBb.sdk),
      getLoopbackBaseUrl: () => "http://127.0.0.1:38886",
      getCredential: () => ({
        serverUrl: "https://sawyer.getbb.app",
        handle: "sawyer",
        credential: "bbcred_x",
      }),
      log: pluginBb.log,
    });

    await registry.load();
    expect(registry.snapshot()).toEqual([
      expect.objectContaining({ hostId: "server", port: 3000 }),
    ]);
    await registry.add(3000, {
      id: SERVER_HOST_ID,
      name: SERVER_HOST_NAME,
      isServer: true,
    });
    expect(registry.snapshot()).toEqual([
      {
        hostId: SERVER_HOST_ID,
        hostName: SERVER_HOST_NAME,
        port: 3000,
        createdAt: 123,
        url: "https://sawyer--3000.getbb.app",
      },
    ]);
    await fakeHost.harness.dispose();
  });

  it("normalizes legacy entries to the server host id at activation", async () => {
    const kv = new Map<string, unknown>([
      [SHARES_KV_KEY, { "3000": { port: 3000, createdAt: 123 } }],
    ]);
    const fakeHost = createConnectFakeHost();
    const pluginBb = fakeHost.bb as unknown as Parameters<typeof plugin>[0];
    const registry = new ShareRegistry({
      kv: {
        async get<T>(key: string) {
          return kv.get(key) as T | undefined;
        },
        async set(key: string, value: unknown) {
          kv.set(key, value);
        },
        async delete(key: string) {
          kv.delete(key);
        },
      },
      hosts: pluginBb.hosts,
      hostResolver: new ShareHostResolver(() => pluginBb.sdk),
      getLoopbackBaseUrl: () => "http://127.0.0.1:38886",
      getCredential: () => ({
        serverUrl: "https://sawyer.getbb.app",
        handle: "sawyer",
        credential: "bbcred_x",
      }),
      log: pluginBb.log,
    });

    await registry.load();
    expect(registry.hasServerPort(3000)).toBe(true);
    await registry.declareMachineShares(() => true);
    expect(kv.get(SHARES_KV_KEY)).toEqual({
      [`${SERVER_HOST_ID}:3000`]: {
        hostId: SERVER_HOST_ID,
        port: 3000,
        createdAt: 123,
      },
    });
    expect(registry.hasServerPort(3000)).toBe(true);
    expect(await registry.remove(3000, SERVER_HOST_ID)).toMatchObject({
      removed: true,
      hostId: SERVER_HOST_ID,
    });
    await fakeHost.harness.dispose();
  });

  it("loads valid entries when another kv entry is malformed", async () => {
    const kv = new Map<string, unknown>([
      [
        SHARES_KV_KEY,
        {
          [`${SERVER_HOST_ID}:8000`]: {
            hostId: SERVER_HOST_ID,
            port: 8000,
            createdAt: 1,
          },
          malformed: { hostId: REMOTE_HOST_ID, port: "nope", createdAt: 2 },
        },
      ],
    ]);
    const fakeHost = createConnectFakeHost();
    const pluginBb = fakeHost.bb as unknown as Parameters<typeof plugin>[0];
    const registry = new ShareRegistry({
      kv: {
        async get<T>(key: string) {
          return kv.get(key) as T | undefined;
        },
        async set(key: string, value: unknown) {
          kv.set(key, value);
        },
        async delete(key: string) {
          kv.delete(key);
        },
      },
      hosts: pluginBb.hosts,
      hostResolver: new ShareHostResolver(() => pluginBb.sdk),
      getLoopbackBaseUrl: () => "http://127.0.0.1:38886",
      getCredential: () => ({
        serverUrl: "https://sawyer.getbb.app",
        handle: "sawyer",
        credential: "bbcred_x",
      }),
      log: pluginBb.log,
    });

    await registry.load();
    expect(registry.isLoaded).toBe(true);
    expect(fakeHost.harness.sdk.callsTo("hosts.get")).toEqual([]);
    expect(fakeHost.harness.sdk.callsTo("system.config")).toEqual([]);
    expect(await registry.list()).toEqual([
      {
        hostId: SERVER_HOST_ID,
        hostName: SERVER_HOST_NAME,
        port: 8000,
        createdAt: 1,
        url: "https://sawyer--8000.getbb.app",
      },
    ]);
    expect(fakeHost.harness.logEntries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          level: "warn",
          message: expect.stringContaining(
            'malformed shared-port entry "malformed"',
          ),
        }),
      ]),
    );
    await fakeHost.harness.dispose();
  });

  it("hydrates offline machine shares without resolving their URLs", async () => {
    const kv = new Map<string, unknown>([
      [
        SHARES_KV_KEY,
        {
          [`${SERVER_HOST_ID}:8000`]: {
            hostId: SERVER_HOST_ID,
            port: 8000,
            createdAt: 1,
          },
          [`${REMOTE_HOST_ID}:3000`]: {
            hostId: REMOTE_HOST_ID,
            port: 3000,
            createdAt: 2,
          },
        },
      ],
    ]);
    const fakeHost = createConnectFakeHost();
    const pluginBb = fakeHost.bb as unknown as Parameters<typeof plugin>[0];
    const ensureIdentity = vi.fn(async () => {
      throw Object.assign(new Error("host is offline"), {
        body: { code: "connect_host_offline" },
      });
    });
    const registry = new ShareRegistry({
      kv: {
        async get<T>(key: string) {
          return kv.get(key) as T | undefined;
        },
        async set(key: string, value: unknown) {
          kv.set(key, value);
        },
        async delete(key: string) {
          kv.delete(key);
        },
      },
      hosts: {
        ensureSharedPortTunnel: ensureIdentity,
        declareSharedPorts: pluginBb.hosts.declareSharedPorts,
      },
      hostResolver: new ShareHostResolver(() => pluginBb.sdk),
      getLoopbackBaseUrl: () => "http://127.0.0.1:38886",
      getCredential: () => ({
        serverUrl: "https://sawyer.getbb.app",
        handle: "sawyer",
        credential: "bbcred_x",
      }),
      log: pluginBb.log,
    });

    await registry.load();
    expect(registry.isLoaded).toBe(true);
    expect(ensureIdentity).not.toHaveBeenCalled();
    expect(fakeHost.harness.sdk.callsTo("hosts.get")).toEqual([]);
    expect(await registry.list()).toEqual([
      {
        hostId: REMOTE_HOST_ID,
        hostName: REMOTE_HOST_NAME,
        port: 3000,
        createdAt: 2,
        url: "",
        unavailableReason: expect.stringMatching(
          /not connected right now.*Bring the host online/,
        ),
      },
      {
        hostId: SERVER_HOST_ID,
        hostName: SERVER_HOST_NAME,
        port: 8000,
        createdAt: 1,
        url: "https://sawyer--8000.getbb.app",
      },
    ]);
    expect(ensureIdentity).toHaveBeenCalledTimes(1);
    await fakeHost.harness.dispose();
  });
});

describe("ConnectTunnel share activation", () => {
  it("does not declare non-empty ports when serverHostId resolves after stop", async () => {
    let resolveServerHostId!: (hostId: string) => void;
    const serverHostId = new Promise<string>((resolve) => {
      resolveServerHostId = resolve;
    });
    let markLookupStarted!: () => void;
    const lookupStarted = new Promise<void>((resolve) => {
      markLookupStarted = resolve;
    });
    const fakeHost = createFakePluginHost({
      pluginId: "connect",
      sdk: {
        system: {
          config: async () => {
            markLookupStarted();
            return { primaryHostId: await serverHostId } as never;
          },
        },
        hosts: {
          get: async ({ hostId }: { hostId: string }) =>
            ({ id: hostId, name: hostId }) as never,
        },
      },
    });
    const pluginBb = fakeHost.bb as unknown as Parameters<typeof plugin>[0];
    const credential = {
      serverUrl: "http://127.0.0.1:1",
      handle: "sawyer",
      credential: "bbcred_x",
    };
    const kv = new Map<string, unknown>([
      [
        SHARES_KV_KEY,
        {
          [`${REMOTE_HOST_ID}:3000`]: {
            hostId: REMOTE_HOST_ID,
            port: 3000,
            createdAt: 1,
          },
        },
      ],
    ]);
    const shares = new ShareRegistry({
      kv: {
        async get<T>(key: string) {
          return kv.get(key) as T | undefined;
        },
        async set(key: string, value: unknown) {
          kv.set(key, value);
        },
        async delete(key: string) {
          kv.delete(key);
        },
      },
      hosts: pluginBb.hosts,
      hostResolver: new ShareHostResolver(() => pluginBb.sdk),
      getLoopbackBaseUrl: () => "http://127.0.0.1:38886",
      getCredential: () => credential,
      log: pluginBb.log,
    });
    const tunnel = new ConnectTunnel({
      store: {
        read: async () => credential,
        write: async () => {},
        clear: async () => {},
      },
      shares,
      defaultBaseUrl: DEFAULT_CONNECT_BASE_URL,
      getLoopbackBaseUrl: () => "http://127.0.0.1:38886",
      log: pluginBb.log,
    });

    await tunnel.start();
    await lookupStarted;
    tunnel.stop();
    resolveServerHostId(SERVER_HOST_ID);
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(
      fakeHost.harness.sharedPortDeclarations.filter(
        (declaration) => declaration.ports.length > 0,
      ),
    ).toEqual([]);
    await fakeHost.harness.dispose();
  });

  it("keeps persisted shares visible in status after an unpaired restart", async () => {
    const fakeHost = createConnectFakeHost();
    const pluginBb = fakeHost.bb as unknown as Parameters<typeof plugin>[0];
    const kv = new Map<string, unknown>([
      [
        SHARES_KV_KEY,
        {
          "3000": { port: 3000, createdAt: 1 },
          [`${REMOTE_HOST_ID}:4000`]: {
            hostId: REMOTE_HOST_ID,
            port: 4000,
            createdAt: 2,
          },
        },
      ],
    ]);
    const shares = new ShareRegistry({
      kv: {
        async get<T>(key: string) {
          return kv.get(key) as T | undefined;
        },
        async set(key: string, value: unknown) {
          kv.set(key, value);
        },
        async delete(key: string) {
          kv.delete(key);
        },
      },
      hosts: pluginBb.hosts,
      hostResolver: new ShareHostResolver(() => pluginBb.sdk),
      getLoopbackBaseUrl: () => "http://127.0.0.1:38886",
      getCredential: () => null,
      log: pluginBb.log,
    });
    const tunnel = new ConnectTunnel({
      store: {
        read: async () => null,
        write: async () => {},
        clear: async () => {},
      },
      shares,
      defaultBaseUrl: DEFAULT_CONNECT_BASE_URL,
      getLoopbackBaseUrl: () => "http://127.0.0.1:38886",
      log: pluginBb.log,
    });

    await tunnel.start();
    await waitFor(() => tunnel.status().shares.length === 2);
    expect(tunnel.status().shares).toEqual([
      expect.objectContaining({
        hostId: REMOTE_HOST_ID,
        port: 4000,
        url: "",
        unavailableReason: "Share URL has not been resolved yet.",
      }),
      expect.objectContaining({
        hostId: "server",
        port: 3000,
        url: "",
        unavailableReason: "Share URL has not been resolved yet.",
      }),
    ]);
    tunnel.stop();
    await fakeHost.harness.dispose();
  });
});

describe("isBareBbRealtimeWs", () => {
  it("matches bare-handle /ws paths only", () => {
    expect(isBareBbRealtimeWs("/ws", undefined)).toBe(true);
    expect(isBareBbRealtimeWs("/ws?x=1", undefined)).toBe(true);
    expect(isBareBbRealtimeWs("/ws/nested", undefined)).toBe(true);
    expect(isBareBbRealtimeWs("/ws", "8000")).toBe(false);
    expect(isBareBbRealtimeWs("/api", undefined)).toBe(false);
  });
});

async function listen(
  handler: (
    req: import("node:http").IncomingMessage,
    res: import("node:http").ServerResponse,
  ) => void,
): Promise<{ server: Server; origin: string; port: number }> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (addr === null || typeof addr === "string") {
    throw new Error("expected TCP address");
  }
  return {
    server,
    origin: `http://127.0.0.1:${addr.port}`,
    port: addr.port,
  };
}

async function waitForOpen(ws: NodeWebSocket): Promise<void> {
  if (ws.readyState === NodeWebSocket.OPEN) return;
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
}

function collectFrames(ws: NodeWebSocket): Frame[] {
  const frames: Frame[] = [];
  ws.on("message", (data: Buffer, isBinary: boolean) => {
    if (isBinary) frames.push(decodeFrame(data));
  });
  return frames;
}

async function waitFor(pred: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitFor timed out");
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("TunnelSession routing", () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    while (cleanups.length > 0) {
      await cleanups.pop()?.();
    }
  });

  it("routes no-target to primary origin, target to a shared port, unregistered → 404", async () => {
    const primaryHits: string[] = [];
    const shareHits: string[] = [];
    const primary = await listen((req, res) => {
      primaryHits.push(`${req.method} ${req.url}`);
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("primary");
    });
    const share = await listen((req, res) => {
      shareHits.push(
        `${req.method} ${req.url} host=${req.headers.host} origin=${req.headers.origin ?? ""}`,
      );
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("shared");
    });
    cleanups.push(
      () =>
        new Promise<void>((resolve) => primary.server.close(() => resolve())),
      () => new Promise<void>((resolve) => share.server.close(() => resolve())),
    );

    const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    await new Promise<void>((resolve) =>
      wss.once("listening", () => resolve()),
    );
    const wssAddr = wss.address();
    if (wssAddr === null || typeof wssAddr === "string") {
      throw new Error("expected TCP address");
    }
    const relayReady = new Promise<NodeWebSocket>((resolve) => {
      wss.on("connection", (socket) => resolve(socket));
    });
    const client = new NodeWebSocket(`ws://127.0.0.1:${wssAddr.port}`);
    cleanups.push(async () => {
      client.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    });
    await waitForOpen(client);
    const relay = await relayReady;
    const frames = collectFrames(relay);

    const sharedPorts = new Set([share.port]);
    const session = new TunnelSession({
      tunnel: client,
      log: {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
      },
      resolveOrigin: (target) => {
        if (target === undefined) {
          return {
            kind: "ok",
            resolved: {
              origin: primary.origin,
              publicOrigin: "https://sawyer.getbb.app",
            },
          };
        }
        const port = Number(target);
        if (!sharedPorts.has(port)) return { kind: "unregistered" };
        return {
          kind: "ok",
          resolved: {
            origin: `http://127.0.0.1:${port}`,
            publicOrigin: `https://sawyer--${port}.getbb.app`,
            host: `127.0.0.1:${port}`,
          },
        };
      },
    });
    session.start();
    cleanups.push(() => session.dispose());

    const inject = (frame: Frame) => {
      relay.send(Buffer.from(encodeFrame(frame)));
    };

    inject({
      type: "open-http",
      streamId: 1,
      method: "GET",
      path: "/hello",
      headers: [["Origin", "https://sawyer.getbb.app"]],
      hasBody: false,
    });
    await waitFor(() =>
      frames.some((f) => f.type === "body-end" && f.streamId === 1),
    );
    expect(primaryHits).toEqual(["GET /hello"]);
    expect(shareHits).toEqual([]);

    frames.length = 0;
    inject({
      type: "open-http",
      streamId: 2,
      method: "GET",
      path: "/app",
      headers: [
        ["Origin", `https://sawyer--${share.port}.getbb.app`],
        ["Host", `sawyer--${share.port}.getbb.app`],
      ],
      hasBody: false,
      target: String(share.port),
    });
    await waitFor(() =>
      frames.some((f) => f.type === "body-end" && f.streamId === 2),
    );
    expect(shareHits).toHaveLength(1);
    expect(shareHits[0]).toContain("GET /app");
    expect(shareHits[0]).toContain(`host=127.0.0.1:${share.port}`);
    expect(shareHits[0]).toContain(`origin=http://127.0.0.1:${share.port}`);
    expect(primaryHits).toEqual(["GET /hello"]);

    frames.length = 0;
    inject({
      type: "open-http",
      streamId: 3,
      method: "GET",
      path: "/nope",
      headers: [],
      hasBody: false,
      target: "59999",
    });
    await waitFor(() =>
      frames.some((f) => f.type === "resp-head" && f.streamId === 3),
    );
    const head = frames.find((f) => f.type === "resp-head" && f.streamId === 3);
    expect(head).toMatchObject({ type: "resp-head", status: 404 });
    const bodyChunks = frames.filter(
      (f) => f.type === "body-chunk" && f.streamId === 3,
    );
    const body = Buffer.concat(
      bodyChunks.map((f) =>
        f.type === "body-chunk" ? Buffer.from(f.data) : Buffer.alloc(0),
      ),
    ).toString();
    expect(body).toBe("this port is not shared");
    expect(frames.some((f) => f.type === "body-end" && f.streamId === 3)).toBe(
      true,
    );
  });

  it("aborts the origin request when the relay closes an HTTP stream", async () => {
    let originStarted = false;
    let originClosed = false;
    const origin = await listen((request, response) => {
      originStarted = true;
      request.once("aborted", () => {
        originClosed = true;
      });
      response.once("close", () => {
        originClosed = true;
      });
    });
    cleanups.push(
      () =>
        new Promise<void>((resolve) => origin.server.close(() => resolve())),
    );

    const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    await new Promise<void>((resolve) =>
      wss.once("listening", () => resolve()),
    );
    const wssAddr = wss.address();
    if (wssAddr === null || typeof wssAddr === "string") {
      throw new Error("expected TCP address");
    }
    const relayReady = new Promise<NodeWebSocket>((resolve) => {
      wss.on("connection", (socket) => resolve(socket));
    });
    const client = new NodeWebSocket(`ws://127.0.0.1:${wssAddr.port}`);
    cleanups.push(async () => {
      client.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    });
    await waitForOpen(client);
    const relay = await relayReady;

    const session = new TunnelSession({
      tunnel: client,
      log: {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
      },
      resolveOrigin: () => ({
        kind: "ok",
        resolved: {
          origin: origin.origin,
          publicOrigin: "https://sawyer.getbb.app",
        },
      }),
    });
    session.start();
    cleanups.push(() => session.dispose());

    relay.send(
      Buffer.from(
        encodeFrame({
          type: "open-http",
          streamId: 41,
          method: "GET",
          path: "/slow",
          headers: [],
          hasBody: false,
        }),
      ),
    );
    await waitFor(() => originStarted);

    relay.send(
      Buffer.from(
        encodeFrame({
          type: "close-stream",
          streamId: 41,
          code: 1000,
          reason: "visitor canceled response body",
        }),
      ),
    );
    await waitFor(() => originClosed);
  });

  it("preserves negotiated origin compression across the tunnel and relays 304 bodiless", async () => {
    const plainBody = "hello ".repeat(200);
    const gzippedBody = gzipSync(Buffer.from(plainBody));
    const acceptEncodings: Array<string | undefined> = [];
    const origin = await listen((req, res) => {
      acceptEncodings.push(req.headers["accept-encoding"]);
      if (req.headers["if-none-match"] === 'W/"v1"') {
        res.writeHead(304, { etag: 'W/"v1"' });
        res.end();
        return;
      }
      res.writeHead(200, {
        "content-type": "text/plain",
        "content-encoding": "gzip",
        "content-length": String(gzippedBody.length),
        etag: 'W/"v1"',
      });
      res.end(gzippedBody);
    });
    cleanups.push(
      () =>
        new Promise<void>((resolve) => origin.server.close(() => resolve())),
    );

    const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    await new Promise<void>((resolve) =>
      wss.once("listening", () => resolve()),
    );
    const wssAddr = wss.address();
    if (wssAddr === null || typeof wssAddr === "string") {
      throw new Error("expected TCP address");
    }
    const relayReady = new Promise<NodeWebSocket>((resolve) => {
      wss.on("connection", (socket) => resolve(socket));
    });
    const client = new NodeWebSocket(`ws://127.0.0.1:${wssAddr.port}`);
    cleanups.push(async () => {
      client.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    });
    await waitForOpen(client);
    const relay = await relayReady;
    const frames = collectFrames(relay);
    const infoMessages: string[] = [];

    const session = new TunnelSession({
      tunnel: client,
      log: {
        debug: () => {},
        info: (message) => infoMessages.push(message),
        warn: () => {},
        error: () => {},
      },
      resolveOrigin: () => ({
        kind: "ok",
        resolved: {
          origin: origin.origin,
          publicOrigin: "https://sawyer.getbb.app",
        },
      }),
    });
    session.start();
    cleanups.push(() => session.dispose());

    const inject = (frame: Frame) => {
      relay.send(Buffer.from(encodeFrame(frame)));
    };

    inject({
      type: "open-http",
      streamId: 21,
      method: "GET",
      path: "/api/v1/threads/thr_test/timeline",
      headers: [["accept-encoding", "gzip"]],
      hasBody: false,
    });
    await waitFor(() =>
      frames.some((f) => f.type === "body-end" && f.streamId === 21),
    );
    const head = frames.find(
      (f) => f.type === "resp-head" && f.streamId === 21,
    );
    if (head?.type !== "resp-head") throw new Error("missing resp-head");
    expect(head.status).toBe(200);
    const headerNames = head.headers.map(([name]) => name.toLowerCase());
    expect(headerNames).toContain("content-encoding");
    expect(headerNames).toContain("content-length");
    expect(headerNames).toContain("etag");
    expect(head.headers).toContainEqual([
      "server-timing",
      expect.stringMatching(/^bb_connect_origin;dur=\d+(?:\.\d+)?$/),
    ]);
    const relayedBody = Buffer.concat(
      frames
        .filter((f) => f.type === "body-chunk" && f.streamId === 21)
        .map((f) =>
          f.type === "body-chunk" ? Buffer.from(f.data) : Buffer.alloc(0),
        ),
    );
    expect(relayedBody).toEqual(gzippedBody);
    expect(acceptEncodings).toEqual(["gzip"]);
    expect(infoMessages).toEqual([
      expect.stringContaining(
        `responseBytes=${gzippedBody.length} contentEncoding=gzip`,
      ),
    ]);

    frames.length = 0;
    inject({
      type: "open-http",
      streamId: 22,
      method: "GET",
      path: "/api/v1/threads/thr_test/timeline",
      headers: [["If-None-Match", 'W/"v1"']],
      hasBody: false,
    });
    await waitFor(() =>
      frames.some((f) => f.type === "body-end" && f.streamId === 22),
    );
    const revalidated = frames.find(
      (f) => f.type === "resp-head" && f.streamId === 22,
    );
    expect(revalidated).toMatchObject({ type: "resp-head", status: 304 });
    expect(
      frames.some((f) => f.type === "body-chunk" && f.streamId === 22),
    ).toBe(false);
  });

  it("tracks remoteClients for bare-handle /ws streams", async () => {
    const origin = await listen((_req, res) => {
      res.writeHead(404);
      res.end();
    });
    const originWss = new WebSocketServer({ server: origin.server });
    cleanups.push(
      () =>
        new Promise<void>((resolve) => {
          originWss.close(() => origin.server.close(() => resolve()));
        }),
    );

    const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    await new Promise<void>((resolve) =>
      wss.once("listening", () => resolve()),
    );
    const wssAddr = wss.address();
    if (wssAddr === null || typeof wssAddr === "string") {
      throw new Error("expected TCP address");
    }
    const relayReady = new Promise<NodeWebSocket>((resolve) => {
      wss.on("connection", (socket) => resolve(socket));
    });
    const client = new NodeWebSocket(`ws://127.0.0.1:${wssAddr.port}`);
    cleanups.push(async () => {
      client.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    });
    await waitForOpen(client);
    const relay = await relayReady;
    const frames = collectFrames(relay);

    const remoteClientsSeen: number[] = [];
    const session = new TunnelSession({
      tunnel: client,
      log: {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
      },
      resolveOrigin: () => ({
        kind: "ok",
        resolved: {
          origin: origin.origin,
          publicOrigin: "https://sawyer.getbb.app",
        },
      }),
      onRemoteClientsChange: (n) => {
        remoteClientsSeen.push(n);
      },
    });
    session.start();
    cleanups.push(() => session.dispose());

    expect(session.remoteClients).toBe(0);

    const inject = (frame: Frame) => {
      relay.send(Buffer.from(encodeFrame(frame)));
    };

    inject({
      type: "open-ws",
      streamId: 10,
      path: "/ws",
      headers: [],
      protocols: [],
    });
    await waitFor(() =>
      frames.some((f) => f.type === "ws-open-ack" && f.streamId === 10),
    );
    expect(session.remoteClients).toBe(1);
    expect(remoteClientsSeen).toContain(1);

    inject({
      type: "close-stream",
      streamId: 10,
      code: 1000,
      reason: "bye",
    });
    await waitFor(() => session.remoteClients === 0);
    expect(remoteClientsSeen).toContain(0);
  });
});

describe("connect plugin", () => {
  let host: FakePluginHost | undefined;

  async function loadPlugin(): Promise<FakePluginHost> {
    host = createConnectFakeHost();
    await plugin(host.bb as unknown as Parameters<typeof plugin>[0]);
    return host;
  }

  async function stopTunnel(current: FakePluginHost): Promise<void> {
    const { controller, done } = current.harness.runService("tunnel");
    controller.abort();
    await done;
  }

  afterEach(async () => {
    if (host) {
      await stopTunnel(host);
      await host.harness.dispose();
      host = undefined;
    }
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("starts unpaired — a healthy state, not needs-configuration", async () => {
    const { harness } = await loadPlugin();
    const status = (await harness.callRpc("status")) as ConnectStatus;
    expect(status).toMatchObject({
      state: "disconnected",
      paired: false,
      handle: null,
      url: null,
      lastError: null,
      remoteClients: 0,
      lastRemoteActivityAt: null,
      shares: [],
    });
    expect(status.dashboardUrl).toBe("https://getbb.app/dashboard");
    expect(status.nextRetryAt).toBeNull();
    expect(harness.needsConfigurationMessages).toEqual([]);
  });

  it("uses the worktree-local Cloud for unpaired development", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("BB_DEV_CONNECT_BASE_URL", "http://bb.localhost:59329");
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ credential: "bbcred_local", handle: "sawyer" }),
          { status: 200 },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { harness } = await loadPlugin();

    const before = (await harness.callRpc("status")) as ConnectStatus;
    expect(before.dashboardUrl).toBe("http://bb.localhost:59329/dashboard");

    const after = (await harness.callRpc("pair", {
      code: "ABCD",
    })) as ConnectStatus;
    expect(fetchMock).toHaveBeenCalledWith(
      "http://bb.localhost:59329/api/connect/redeem",
      expect.objectContaining({ method: "POST" }),
    );
    expect(after.url).toBe("http://sawyer.bb.localhost:59329");
  });

  it("lets an explicit production server override the development default", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("BB_DEV_CONNECT_BASE_URL", "http://bb.localhost:59329");
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: "invalid-code" }), {
          status: 404,
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { harness } = await loadPlugin();

    await expect(
      harness.callRpc("pair", {
        code: "ABCD",
        server: "https://sawyer.getbb.app",
      }),
    ).rejects.toThrow("invalid_code");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://getbb.app/api/connect/redeem",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("registers contributeInstructions", async () => {
    const { harness } = await loadPlugin();
    expect(harness.registrations.instructionProvider).not.toBeNull();
    expect(
      harness.registrations.instructionProvider?.({
        threadId: "th_1",
        projectId: "proj_1",
      }),
    ).toBeNull();
  });

  it("pair redeems, persists the credential to kv, and reports paired", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ credential: "bbcred_live", handle: "sawyer" }),
          { status: 200 },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { bb, harness } = await loadPlugin();

    const status = (await harness.callRpc("pair", {
      code: "ABCD",
      server: "http://127.0.0.1:59321",
      baseUrl: "https://getbb.app",
    })) as ConnectStatus;

    expect(fetchMock).toHaveBeenCalledWith(
      "https://getbb.app/api/connect/redeem",
      expect.objectContaining({ method: "POST" }),
    );
    expect(status.paired).toBe(true);
    expect(status.handle).toBe("sawyer");
    expect(status.url).toBe("http://127.0.0.1:59321");
    const stored = (await bb.storage.kv.get(CREDENTIAL_KV_KEY)) as {
      credential: string;
    };
    expect(stored.credential).toBe("bbcred_live");
    const states = harness.realtimeSignals
      .filter((signal) => signal.channel === "connect")
      .map((signal) => (signal.payload as ConnectStatus).state);
    expect(states).toContain("pairing");
  });

  it("pair without --server derives the URL from the redeemed handle", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ credential: "bbcred_live", handle: "sawyer" }),
          { status: 200 },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { harness } = await loadPlugin();

    const status = (await harness.callRpc("pair", {
      code: "ABCD",
      baseUrl: "http://localhost:59329",
    })) as ConnectStatus;

    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:59329/api/connect/redeem",
      expect.objectContaining({ method: "POST" }),
    );
    expect(status.url).toBe("http://sawyer.localhost:59329");
    expect(status.paired).toBe(true);
  });

  it("pair stores a non-primary routing label from redeem (multi-server)", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            credential: "bbcred_second",
            handle: "sawyer-desktop",
          }),
          { status: 200 },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { bb, harness } = await loadPlugin();

    const status = (await harness.callRpc("pair", {
      code: "ABCD",
      baseUrl: "http://localhost:59332",
    })) as ConnectStatus;

    expect(status.paired).toBe(true);
    expect(status.handle).toBe("sawyer-desktop");
    expect(status.url).toBe("http://sawyer-desktop.localhost:59332");

    const stored = (await bb.storage.kv.get(CREDENTIAL_KV_KEY)) as {
      serverUrl: string;
      handle: string;
      credential: string;
    };
    expect(stored).toEqual({
      serverUrl: "http://sawyer-desktop.localhost:59332",
      handle: "sawyer-desktop",
      credential: "bbcred_second",
    });

    const exposed = (await harness.callRpc("expose", { port: 8000 })) as {
      port: number;
      url: string;
    };
    expect(exposed.url).toBe("http://sawyer-desktop--8000.localhost:59332");
  });

  it("disconnect revokes the Cloud credential and clears it locally", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/api/connect/redeem")) {
        return Response.json({
          credential: "bbcred_x",
          handle: "sawyer",
        });
      }
      return Response.json({ ok: true });
    });
    vi.stubGlobal("fetch", fetchMock);
    const { bb, harness } = await loadPlugin();
    await harness.callRpc("pair", {
      code: "ABCD",
      server: "http://127.0.0.1:59322",
      baseUrl: "https://getbb.app",
    });

    const after = (await harness.callRpc("disconnect")) as ConnectStatus;
    expect(after.paired).toBe(false);
    expect(after.state).toBe("disconnected");
    expect(await bb.storage.kv.get(CREDENTIAL_KV_KEY)).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith(
      new URL("http://127.0.0.1:59322/api/connect/disconnect"),
      expect.objectContaining({
        method: "POST",
        headers: { "x-bb-connect-machine": "bbcred_x" },
      }),
    );
  });

  it("still disconnects locally when Cloud cannot be reached", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/api/connect/redeem")) {
        return Response.json({
          credential: "bbcred_offline",
          handle: "sawyer",
        });
      }
      throw new Error("network unavailable");
    });
    vi.stubGlobal("fetch", fetchMock);
    const { bb, harness } = await loadPlugin();
    await harness.callRpc("pair", {
      code: "ABCD",
      server: "http://127.0.0.1:59323",
      baseUrl: "https://getbb.app",
    });

    const after = (await harness.callRpc("disconnect")) as ConnectStatus;
    expect(after.paired).toBe(false);
    expect(await bb.storage.kv.get(CREDENTIAL_KV_KEY)).toBeUndefined();
    expect(harness.logEntries).toContainEqual({
      level: "warn",
      message: "Cloud disconnect could not be confirmed: network unavailable",
    });
  });

  it("maps a redeem failure to a typed code (no wire text) and does not persist", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: "expired" }), { status: 410 }),
      ),
    );
    const { bb, harness } = await loadPlugin();

    await expect(
      harness.callRpc("pair", {
        code: "OLD",
        server: "https://sawyer.getbb.app",
      }),
    ).rejects.toThrow("expired_code");
    expect(await bb.storage.kv.get(CREDENTIAL_KV_KEY)).toBeUndefined();
    const status = (await harness.callRpc("status")) as ConnectStatus;
    expect(status.state).toBe("disconnected");
  });

  it("maps redeem status/detail to invalid_code / already_used / network codes", async () => {
    const cases: Array<{ status: number; error: string; code: string }> = [
      { status: 404, error: "invalid-code", code: "invalid_code" },
      { status: 409, error: "already-used", code: "already_used" },
      { status: 500, error: "boom", code: "network" },
    ];
    for (const testCase of cases) {
      vi.stubGlobal(
        "fetch",
        vi.fn(
          async () =>
            new Response(JSON.stringify({ error: testCase.error }), {
              status: testCase.status,
            }),
        ),
      );
      const { harness } = await loadPlugin();
      await expect(
        harness.callRpc("pair", {
          code: "X",
          server: "https://sawyer.getbb.app",
        }),
      ).rejects.toThrow(testCase.code);
      await stopTunnel(host!);
      await host!.harness.dispose();
      host = undefined;
      vi.unstubAllGlobals();
    }
  });

  it("the tunnel service reconnects from a stored credential", async () => {
    const { bb, harness } = await loadPlugin();
    await bb.storage.kv.set(CREDENTIAL_KV_KEY, {
      serverUrl: "http://127.0.0.1:59323",
      handle: "sawyer",
      credential: "bbcred_x",
    });

    const { controller, done } = harness.runService("tunnel");
    await vi.waitFor(async () => {
      const status = (await harness.callRpc("status")) as ConnectStatus;
      expect(status.paired).toBe(true);
      expect(status.state).toBe("reconnecting");
    });
    controller.abort();
    await done;
  });

  it("expose / listShares / unexpose rpc round-trip when paired", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ credential: "bbcred_live", handle: "sawyer" }),
            { status: 200 },
          ),
      ),
    );
    const { harness } = await loadPlugin();
    await harness.callRpc("pair", {
      code: "ABCD",
      server: "http://sawyer.localhost:59330",
      baseUrl: "https://getbb.app",
    });

    const shareUrl = "http://sawyer--8000.localhost:59330";
    const exposed = (await harness.callRpc("expose", { port: 8000 })) as {
      port: number;
      url: string;
    };
    expect(exposed).toEqual({
      hostId: SERVER_HOST_ID,
      hostName: SERVER_HOST_NAME,
      port: 8000,
      url: shareUrl,
      createdAt: expect.any(Number),
    });

    const listed = (await harness.callRpc("listShares")) as Array<{
      port: number;
      url: string;
    }>;
    expect(listed).toEqual([
      {
        hostId: SERVER_HOST_ID,
        hostName: SERVER_HOST_NAME,
        port: 8000,
        url: shareUrl,
        createdAt: expect.any(Number),
      },
    ]);

    const status = (await harness.callRpc("status")) as ConnectStatus;
    expect(status.shares).toEqual([
      {
        hostId: SERVER_HOST_ID,
        hostName: SERVER_HOST_NAME,
        port: 8000,
        url: shareUrl,
        createdAt: expect.any(Number),
      },
    ]);

    const removed = (await harness.callRpc("unexpose", { port: 8000 })) as {
      removed: boolean;
      port: number;
    };
    expect(removed).toEqual({
      removed: true,
      hostId: SERVER_HOST_ID,
      hostName: SERVER_HOST_NAME,
      port: 8000,
    });
    expect(await harness.callRpc("listShares")).toEqual([]);
  });

  it("rejects tunnel identity fields on expose and unexpose rpc inputs", async () => {
    const { harness } = await loadPlugin();
    const redirected = {
      port: 3000,
      hostId: REMOTE_HOST_ID,
      label: "attacker",
      baseDomain: "attacker.example",
    };

    await expect(harness.callRpc("expose", redirected)).rejects.toMatchObject({
      code: "invalid_input",
      issues: expect.any(Array),
    });
    await expect(harness.callRpc("unexpose", redirected)).rejects.toMatchObject(
      {
        code: "invalid_input",
        issues: expect.any(Array),
      },
    );
  });

  it("keeps valid shares loaded when a host was removed and prunes orphaned shares without a host lookup", async () => {
    const { bb, harness } = await loadPlugin();
    await bb.storage.kv.set(SHARES_KV_KEY, {
      [`${SERVER_HOST_ID}:8000`]: {
        hostId: SERVER_HOST_ID,
        port: 8000,
        createdAt: 1,
      },
      "host-deleted:3000": {
        hostId: "host-deleted",
        port: 3000,
        createdAt: 2,
      },
      "host-deleted:4000": {
        hostId: "host-deleted",
        port: 4000,
        createdAt: 3,
      },
    });

    await expect(
      harness.callRpc("unexpose", { hostId: "host-deleted", port: 3000 }),
    ).resolves.toEqual({
      removed: true,
      hostId: "host-deleted",
      hostName: "removed host",
      port: 3000,
    });
    expect(await harness.callRpc("listShares")).toEqual(
      expect.arrayContaining([
        {
          hostId: SERVER_HOST_ID,
          hostName: SERVER_HOST_NAME,
          port: 8000,
          url: "http://127.0.0.1:8000",
          createdAt: 1,
        },
        expect.objectContaining({
          hostId: "host-deleted",
          hostName: "removed host",
          port: 4000,
          url: "",
          unavailableReason: expect.stringContaining("was removed"),
        }),
      ]),
    );
    const cliRemoval = await harness.runCli([
      "unexpose",
      "4000",
      "--host",
      "host-deleted",
    ]);
    expect(cliRemoval).toMatchObject({
      exitCode: 0,
      stdout: "Stopped sharing port 4000 on removed host (host-deleted)\n",
    });
    expect(await bb.storage.kv.get(SHARES_KV_KEY)).toEqual({
      [`${SERVER_HOST_ID}:8000`]: {
        hostId: SERVER_HOST_ID,
        port: 8000,
        createdAt: 1,
      },
    });
    expect(harness.sharedPortDeclarations).toEqual([
      { hostId: "host-deleted", ports: [] },
    ]);
  });

  it("unexposes a persisted machine share when its declaration update fails", async () => {
    host = createConnectFakeHost();
    const declarations = vi.fn((_hostId: string, _ports: readonly number[]) => {
      throw new Error("temporary declaration failure");
    });
    Object.defineProperty(host.bb.hosts, "declareSharedPorts", {
      value: declarations,
    });
    await plugin(host.bb as unknown as Parameters<typeof plugin>[0]);
    await host.bb.storage.kv.set(SHARES_KV_KEY, {
      [`${REMOTE_HOST_ID}:3000`]: {
        hostId: REMOTE_HOST_ID,
        port: 3000,
        createdAt: 1,
      },
    });

    await expect(
      host.harness.callRpc("unexpose", {
        hostId: REMOTE_HOST_ID,
        port: 3000,
      }),
    ).resolves.toEqual({
      removed: true,
      hostId: REMOTE_HOST_ID,
      hostName: REMOTE_HOST_NAME,
      port: 3000,
    });
    expect(declarations).toHaveBeenCalledWith(REMOTE_HOST_ID, []);
    expect(await host.bb.storage.kv.get(SHARES_KV_KEY)).toBeUndefined();
    expect(await host.harness.callRpc("listShares")).toEqual([]);
    expect(host.harness.sdk.callsTo("hosts.get")).toEqual(
      expect.arrayContaining([
        [expect.objectContaining({ hostId: REMOTE_HOST_ID })],
      ]),
    );
    expect(host.harness.logEntries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          level: "warn",
          message: expect.stringContaining(
            "failed to update shared ports after removing port 3000",
          ),
        }),
      ]),
    );
  });

  it("uses machine tunnel identity and declares per-host port sets", async () => {
    host = createConnectFakeHost({
      remoteIdentity: { label: "sawyer-air", baseDomain: "getbb.app" },
    });
    await plugin(host.bb as unknown as Parameters<typeof plugin>[0]);
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ credential: "bbcred_live", handle: "sawyer" }),
            { status: 200 },
          ),
      ),
    );
    await host.harness.callRpc("pair", {
      code: "ABCD",
      server: "http://sawyer.localhost:59333",
      baseUrl: "https://getbb.app",
    });

    await expect(
      host.harness.callRpc("expose", { hostId: REMOTE_HOST_ID, port: 3000 }),
    ).resolves.toEqual({
      hostId: REMOTE_HOST_ID,
      hostName: REMOTE_HOST_NAME,
      port: 3000,
      url: "https://sawyer-air--3000.getbb.app",
      createdAt: expect.any(Number),
    });
    expect(host.harness.sharedPortDeclarations).toEqual([
      { hostId: REMOTE_HOST_ID, ports: [3000] },
    ]);

    await host.harness.callRpc("expose", {
      hostId: REMOTE_HOST_ID,
      port: 4000,
    });
    expect(host.harness.sharedPortDeclarations).toEqual([
      { hostId: REMOTE_HOST_ID, ports: [3000, 4000] },
    ]);

    await host.harness.callRpc("expose", { port: 3000 });
    expect(host.harness.sharedPortDeclarations).toEqual([
      { hostId: REMOTE_HOST_ID, ports: [3000, 4000] },
    ]);
    expect(
      ((await host.harness.callRpc("status")) as ConnectStatus).shares,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ hostId: SERVER_HOST_ID, port: 3000 }),
        expect.objectContaining({ hostId: REMOTE_HOST_ID, port: 3000 }),
      ]),
    );

    await host.harness.callRpc("unexpose", {
      hostId: REMOTE_HOST_ID,
      port: 3000,
    });
    expect(host.harness.sharedPortDeclarations).toEqual([
      { hostId: REMOTE_HOST_ID, ports: [4000] },
    ]);
    await host.harness.callRpc("unexpose", {
      hostId: REMOTE_HOST_ID,
      port: 4000,
    });
    expect(host.harness.sharedPortDeclarations).toEqual([
      { hostId: REMOTE_HOST_ID, ports: [] },
    ]);
  });

  it("tells users to enroll a genuinely credentialless machine", async () => {
    host = createConnectFakeHost();
    Object.defineProperty(host.bb.hosts, "ensureSharedPortTunnel", {
      value: async () => {
        throw Object.assign(new Error("machine credential missing"), {
          body: { code: "connect_host_unenrolled" },
        });
      },
    });
    await plugin(host.bb as unknown as Parameters<typeof plugin>[0]);
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ credential: "bbcred_live", handle: "sawyer" }),
            { status: 200 },
          ),
      ),
    );
    await host.harness.callRpc("pair", {
      code: "ABCD",
      server: "http://sawyer.localhost:59334",
      baseUrl: "https://getbb.app",
    });

    await expect(
      host.harness.callRpc("expose", {
        hostId: REMOTE_HOST_ID,
        port: 3000,
      }),
    ).rejects.toThrow(
      /Sawyer Air.*host-air.*Enroll it via Connect.*Settings > Machines/,
    );
    expect(await host.harness.callRpc("listShares")).toEqual([]);
    expect(host.harness.sharedPortDeclarations).toEqual([]);
  });

  it("tells users to bring an enrolled but offline machine online", async () => {
    host = createConnectFakeHost();
    Object.defineProperty(host.bb.hosts, "ensureSharedPortTunnel", {
      value: async () => {
        throw Object.assign(new Error("host is offline"), {
          body: { code: "connect_host_offline" },
        });
      },
    });
    await plugin(host.bb as unknown as Parameters<typeof plugin>[0]);
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ credential: "bbcred_live", handle: "sawyer" }),
            { status: 200 },
          ),
      ),
    );
    await host.harness.callRpc("pair", {
      code: "ABCD",
      server: "http://sawyer.localhost:59335",
      baseUrl: "https://getbb.app",
    });

    let message = "";
    try {
      await host.harness.callRpc("expose", {
        hostId: REMOTE_HOST_ID,
        port: 3000,
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toMatch(
      /Sawyer Air.*host-air.*not connected right now.*Bring the host online/,
    );
    expect(message).not.toMatch(/Enroll|remove and re-add/);
  });

  it("empties machine declarations when the pairing is disconnected", async () => {
    host = createConnectFakeHost({
      remoteIdentity: { label: "sawyer-air", baseDomain: "getbb.app" },
    });
    await plugin(host.bb as unknown as Parameters<typeof plugin>[0]);
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ credential: "bbcred_live", handle: "sawyer" }),
            { status: 200 },
          ),
      ),
    );
    await host.harness.callRpc("pair", {
      code: "ABCD",
      server: "http://sawyer.localhost:59335",
      baseUrl: "https://getbb.app",
    });
    await host.harness.callRpc("expose", {
      hostId: REMOTE_HOST_ID,
      port: 5173,
    });
    expect(host.harness.sharedPortDeclarations).toEqual([
      { hostId: REMOTE_HOST_ID, ports: [5173] },
    ]);

    await host.harness.callRpc("disconnect");
    expect(host.harness.sharedPortDeclarations).toEqual([
      { hostId: REMOTE_HOST_ID, ports: [] },
    ]);
    await stopTunnel(host);
    await host.harness.dispose();
    host = undefined;
  });

  it("listAccountServers fetches the worker list and returns selfHandle", async () => {
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, _init?: RequestInit) => {
        const url = String(input);
        if (url.includes("/api/connect/redeem")) {
          return new Response(
            JSON.stringify({ credential: "bbcred_live", handle: "sawyer" }),
            { status: 200 },
          );
        }
        if (url.includes("/api/connect/servers")) {
          return new Response(
            JSON.stringify({
              servers: [
                { handle: "sawyer", name: "default", live: true },
                { handle: "sawyer-desktop", name: "desktop", live: false },
              ],
            }),
            { status: 200 },
          );
        }
        return new Response("not found", { status: 404 });
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    const { harness } = await loadPlugin();
    await harness.callRpc("pair", {
      code: "ABCD",
      server: "http://sawyer.localhost:59340",
      baseUrl: "https://getbb.app",
    });

    const result = (await harness.callRpc("listAccountServers")) as {
      servers: Array<{
        handle: string;
        name: string;
        live: boolean;
        url: string;
      }>;
      selfHandle: string;
    };
    expect(result).toEqual({
      servers: [
        {
          handle: "sawyer",
          name: "default",
          live: true,
          url: "http://sawyer.localhost:59340",
        },
        {
          handle: "sawyer-desktop",
          name: "desktop",
          live: false,
          url: "http://sawyer-desktop.localhost:59340",
        },
      ],
      selfHandle: "sawyer",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://sawyer.localhost:59340/api/connect/servers",
      expect.objectContaining({
        method: "GET",
        headers: { "x-bb-connect-machine": "bbcred_live" },
      }),
    );
  });

  it("listAccountServers when unpaired returns a typed not_paired code", async () => {
    const { harness } = await loadPlugin();
    await expect(harness.callRpc("listAccountServers")).rejects.toThrow(
      "not_paired",
    );
  });

  it("createDesktopSession exchanges the stored credential without returning it", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/connect/redeem")) {
        return new Response(
          JSON.stringify({ credential: "bbcred_durable", handle: "sawyer" }),
          { status: 200 },
        );
      }
      if (url.includes("/api/connect/desktop-session")) {
        return new Response(
          JSON.stringify({
            cookie: {
              domain: ".getbb.app",
              expiresAt: 2_000_000,
              name: "__Secure-bb-connect.desktop_session",
              value: "short-lived-signed-cookie",
            },
          }),
        );
      }
      return new Response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const { harness } = await loadPlugin();
    await harness.callRpc("pair", {
      code: "ABCD",
      server: "https://sawyer.getbb.app",
    });
    await expect(harness.callRpc("createDesktopSession")).resolves.toEqual({
      cookie: {
        domain: ".getbb.app",
        expiresAt: 2_000_000,
        name: "__Secure-bb-connect.desktop_session",
        value: "short-lived-signed-cookie",
      },
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://sawyer.getbb.app/api/connect/desktop-session",
      expect.objectContaining({
        method: "POST",
        headers: { "x-bb-connect-machine": "bbcred_durable" },
      }),
    );
  });

  it("createMachineCode mints through the apex with the stored server credential", async () => {
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, _init?: RequestInit) => {
        const url = String(input);
        if (url.includes("/api/connect/redeem")) {
          return new Response(
            JSON.stringify({ credential: "bbcred_durable", handle: "sawyer" }),
            { status: 200 },
          );
        }
        if (url === "https://getbb.app/api/connect/machine-code") {
          return new Response(
            JSON.stringify({
              code: "ABCD-EFGH",
              expiresInMs: 600_000,
              serverUrl: "https://sawyer.getbb.app",
            }),
          );
        }
        return new Response("not found", { status: 404 });
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    const { harness } = await loadPlugin();
    await harness.callRpc("pair", {
      code: "ABCD",
      server: "https://sawyer.getbb.app",
    });
    const before = Date.now();
    await expect(harness.callRpc("createMachineCode")).resolves.toMatchObject({
      code: "ABCD-EFGH",
      serverUrl: "https://sawyer.getbb.app",
      expiresAt: expect.any(Number),
    });
    const call = fetchMock.mock.calls.find(
      ([input]) =>
        String(input) === "https://getbb.app/api/connect/machine-code",
    );
    expect(call?.[1]).toEqual({
      method: "POST",
      headers: { "x-bb-connect-machine": "bbcred_durable" },
    });
    const result = (await harness.callRpc("createMachineCode")) as {
      expiresAt: number;
    };
    expect(result.expiresAt).toBeGreaterThanOrEqual(before + 600_000);
  });

  it("createMachineCode reports not_paired without making a request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { harness } = await loadPlugin();
    await expect(harness.callRpc("createMachineCode")).rejects.toThrow(
      "not_paired",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("revokeMachine uses the stored server credential", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/connect/redeem")) {
        return Response.json({
          credential: "bbcred_durable",
          handle: "sawyer",
        });
      }
      if (url === "https://getbb.app/api/connect/revoke-machine") {
        return Response.json({ ok: true });
      }
      return new Response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const { harness } = await loadPlugin();
    await harness.callRpc("pair", {
      code: "ABCD",
      server: "https://sawyer.getbb.app",
    });

    await expect(
      harness.callRpc("revokeMachine", { machineId: "machine-1" }),
    ).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://getbb.app/api/connect/revoke-machine",
      expect.objectContaining({
        body: JSON.stringify({ machineId: "machine-1" }),
        headers: {
          "content-type": "application/json",
          "x-bb-connect-machine": "bbcred_durable",
        },
        method: "POST",
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("routes local machine creation and revocation through the unified Cloud origin", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/connect/redeem")) {
        return Response.json({
          credential: "bbcred_local",
          handle: "sawyer",
        });
      }
      if (url === "http://bb.localhost:59330/api/connect/machine-code") {
        return Response.json({
          code: "ABCD-EFGH",
          expiresInMs: 600_000,
          serverUrl: "http://sawyer.bb.localhost:59330",
        });
      }
      if (url === "http://bb.localhost:59330/api/connect/revoke-machine") {
        return Response.json({ ok: true });
      }
      return new Response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const { harness } = await loadPlugin();
    await harness.callRpc("pair", {
      code: "ABCD",
      server: "http://sawyer.bb.localhost:59330",
    });

    await expect(harness.callRpc("createMachineCode")).resolves.toMatchObject({
      code: "ABCD-EFGH",
      serverUrl: "http://sawyer.bb.localhost:59330",
    });
    await expect(
      harness.callRpc("revokeMachine", { machineId: "machine-local" }),
    ).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://bb.localhost:59330/api/connect/machine-code",
      expect.objectContaining({ method: "POST" }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "http://bb.localhost:59330/api/connect/revoke-machine",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("listAccountServers surfaces unauthorized cleanly on 401", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/connect/redeem")) {
        return new Response(
          JSON.stringify({ credential: "bbcred_live", handle: "sawyer" }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401,
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const { harness } = await loadPlugin();
    await harness.callRpc("pair", {
      code: "ABCD",
      server: "http://sawyer.localhost:59341",
      baseUrl: "https://getbb.app",
    });
    await expect(harness.callRpc("listAccountServers")).rejects.toThrow(
      "unauthorized",
    );
  });
});

describe("connect CLI", () => {
  let host: FakePluginHost | undefined;

  afterEach(async () => {
    if (host) {
      const { controller, done } = host.harness.runService("tunnel");
      controller.abort();
      await done;
      await host.harness.dispose();
      host = undefined;
    }
    vi.unstubAllGlobals();
  });

  async function loadCli(options?: {
    mobileApp?: boolean;
  }): Promise<FakePluginHost> {
    host = createConnectFakeHost(options);
    await plugin(host.bb as unknown as Parameters<typeof plugin>[0]);
    return host;
  }

  it("bare `bb connect` prints a how-to, not an argument error", async () => {
    const { harness } = await loadCli();
    const result = await harness.runCli([]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("getbb.app");
    expect(result.stdout).toContain("bb connect status");
    expect(result.stdout).toContain("bb connect expose");
  });

  it("`bb connect --code --server` pairs verbatim (the dashboard command)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ credential: "bbcred_live", handle: "sawyer" }),
            { status: 200 },
          ),
      ),
    );
    const { harness } = await loadCli();
    const result = await harness.runCli([
      "--code",
      "ABCD",
      "--server",
      "http://127.0.0.1:59324",
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(
      "Paired as sawyer — reachable at http://127.0.0.1:59324",
    );
  });

  it("`bb connect status` and `bb connect off` round-trip", async () => {
    const { harness } = await loadCli();
    const before = await harness.runCli(["status"]);
    expect(before.exitCode).toBe(0);
    expect(before.stdout).toContain("Not paired");

    const off = await harness.runCli(["off"]);
    expect(off.exitCode).toBe(0);
    expect(off.stdout).toContain("Disconnected");
  });

  it("unknown subcommands fail with help", async () => {
    const { harness } = await loadCli();
    const result = await harness.runCli(["bogus"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Unknown connect command 'bogus'");
  });

  it("a failed pair surfaces the redeem error on stderr", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: "expired" }), { status: 410 }),
      ),
    );
    const { harness } = await loadCli();
    const result = await harness.runCli([
      "--code",
      "OLD",
      "--server",
      "https://sawyer.getbb.app",
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Redeem failed (410): expired");
  });

  it("expose when unpaired errors clearly", async () => {
    const { harness } = await loadCli();
    const result = await harness.runCli(["expose", "8000"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("not connected to getbb.app");
  });

  it("servers when unpaired errors clearly", async () => {
    const { harness } = await loadCli();
    const result = await harness.runCli(["servers"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("not connected to getbb.app");
  });

  it("servers lists account servers as a table or json", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/connect/redeem")) {
        return new Response(
          JSON.stringify({ credential: "bbcred_live", handle: "sawyer" }),
          { status: 200 },
        );
      }
      if (url.includes("/api/connect/servers")) {
        return new Response(
          JSON.stringify({
            servers: [
              { handle: "sawyer", name: "default", live: true },
              { handle: "sawyer-desktop", name: "desktop", live: false },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const { harness } = await loadCli();
    await harness.runCli([
      "--code",
      "ABCD",
      "--server",
      "http://sawyer.localhost:59342",
    ]);

    const table = await harness.runCli(["servers"]);
    expect(table.exitCode).toBe(0);
    expect(table.stdout).toContain("sawyer");
    expect(table.stdout).toContain("desktop");
    expect(table.stdout).toContain("http://sawyer.localhost:59342");
    expect(table.stdout).toContain("http://sawyer-desktop.localhost:59342");
    expect(table.stdout).toContain("yes");
    expect(table.stdout).toContain("no");

    const json = await harness.runCli(["servers", "--json"]);
    expect(json.exitCode).toBe(0);
    expect(json.stdout).toBeTruthy();
    const parsed = JSON.parse(json.stdout ?? "") as {
      servers: Array<{ handle: string; url: string }>;
      selfHandle: string;
    };
    expect(parsed.selfHandle).toBe("sawyer");
    expect(parsed.servers).toHaveLength(2);
    expect(parsed.servers[0]?.url).toBe("http://sawyer.localhost:59342");
    expect(parsed.servers[1]?.url).toBe(
      "http://sawyer-desktop.localhost:59342",
    );
  });

  it("machine-code is off until the mobileApp experiment is on", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { harness } = await loadCli({ mobileApp: false });
    const result = await harness.runCli(["machine-code"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('"Mobile app" experiment');
    expect(result.stderr).toContain("bb settings experiment mobileApp true");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("machine-code when unpaired errors clearly", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { harness } = await loadCli();
    const result = await harness.runCli(["machine-code"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("not connected to getbb.app");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("machine-code prints the pairing payload as text or json", async () => {
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, _init?: RequestInit) => {
        const url = String(input);
        if (url.includes("/api/connect/redeem")) {
          return new Response(
            JSON.stringify({ credential: "bbcred_live", handle: "sawyer" }),
            { status: 200 },
          );
        }
        if (url === "https://getbb.app/api/connect/machine-code") {
          return new Response(
            JSON.stringify({
              code: "K7QP-2M4X",
              expiresInMs: 600_000,
              serverUrl: "https://sawyer.getbb.app",
            }),
          );
        }
        return new Response("not found", { status: 404 });
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    const { harness } = await loadCli();
    await harness.runCli([
      "--code",
      "ABCD",
      "--server",
      "https://sawyer.getbb.app",
    ]);

    const before = Date.now();
    const text = await harness.runCli(["machine-code"]);
    expect(text.exitCode).toBe(0);
    expect(text.stdout).toContain("Code:       K7QP-2M4X");
    expect(text.stdout).toContain("Server:     https://sawyer.getbb.app");
    expect(text.stdout).toContain("Apex:       https://getbb.app");
    expect(text.stdout).toContain("in about 10 min");
    expect(text.stdout).toContain("Add mobile device");

    const json = await harness.runCli(["machine-code", "--json"]);
    expect(json.exitCode).toBe(0);
    const parsed = JSON.parse(json.stdout ?? "") as Record<string, unknown>;
    expect(parsed).toEqual({
      code: "K7QP-2M4X",
      serverUrl: "https://sawyer.getbb.app",
      apex: "https://getbb.app",
      expiresAt: expect.any(Number),
    });
    expect(parsed.expiresAt as number).toBeGreaterThanOrEqual(before + 600_000);
    const call = fetchMock.mock.calls.find(
      ([input]) =>
        String(input) === "https://getbb.app/api/connect/machine-code",
    );
    expect(call?.[1]).toEqual({
      method: "POST",
      headers: { "x-bb-connect-machine": "bbcred_live" },
    });
  });

  it("machine-code explains the account machine limit and names the dashboard", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/api/connect/redeem")) {
          return new Response(
            JSON.stringify({ credential: "bbcred_live", handle: "sawyer" }),
            { status: 200 },
          );
        }
        if (url.endsWith("/api/connect/machine-code")) {
          return new Response(JSON.stringify({ error: "machine-limit" }), {
            status: 409,
          });
        }
        return new Response("not found", { status: 404 });
      }),
    );
    const { harness } = await loadCli();
    await harness.runCli([
      "--code",
      "ABCD",
      "--server",
      "https://sawyer.getbb.app",
    ]);
    const result = await harness.runCli(["machine-code"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("machine limit");
    expect(result.stderr).toContain("https://getbb.app/dashboard");
    expect(result.stderr).not.toContain("machine_limit");
  });

  it("expose / shares / unexpose happy path", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ credential: "bbcred_live", handle: "sawyer" }),
            { status: 200 },
          ),
      ),
    );
    const { harness } = await loadCli();
    await harness.runCli([
      "--code",
      "ABCD",
      "--server",
      "http://sawyer.localhost:59331",
    ]);

    const shareUrl = "http://sawyer--8000.localhost:59331";
    const exposed = await harness.runCli(["expose", "8000"]);
    expect(exposed.exitCode).toBe(0);
    expect(exposed.stdout).toContain(shareUrl);

    const shares = await harness.runCli(["shares"]);
    expect(shares.exitCode).toBe(0);
    expect(shares.stdout).toContain("8000");
    expect(shares.stdout).toContain(shareUrl);

    const status = await harness.runCli(["status"]);
    expect(status.stdout).toContain("shares:");
    expect(status.stdout).toContain("8000");

    const unexpose = await harness.runCli(["unexpose", "8000"]);
    expect(unexpose.exitCode).toBe(0);
    expect(unexpose.stdout).toContain("Stopped sharing port 8000");

    const again = await harness.runCli(["unexpose", "8000"]);
    expect(again.exitCode).toBe(0);
    expect(again.stdout).toContain("was not shared");

    const empty = await harness.runCli(["shares"]);
    expect(empty.stdout).toContain("No shared ports");
  });

  it("resolves the thread host, honors --host, and defaults no-context calls to the server host", async () => {
    host = createConnectFakeHost({
      remoteIdentity: { label: "sawyer-air", baseDomain: "getbb.app" },
    });
    await plugin(host.bb as unknown as Parameters<typeof plugin>[0]);
    host.harness.sdk.stub(
      "threads.get",
      async () => ({ environment: { hostId: REMOTE_HOST_ID } }) as never,
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ credential: "bbcred_live", handle: "sawyer" }),
            { status: 200 },
          ),
      ),
    );
    await host.harness.runCli([
      "--code",
      "ABCD",
      "--server",
      "http://sawyer.localhost:59336",
    ]);

    const fromThread = await host.harness.runCli(["expose", "3000"], {
      threadId: "thread-air",
    });
    expect(fromThread).toMatchObject({
      exitCode: 0,
      stdout: "https://sawyer-air--3000.getbb.app\n",
    });

    const overridden = await host.harness.runCli(
      ["expose", "3000", "--host", SERVER_HOST_NAME],
      { threadId: "thread-air" },
    );
    expect(overridden).toMatchObject({
      exitCode: 0,
      stdout: "http://sawyer--3000.localhost:59336\n",
    });

    const noContext = await host.harness.runCli(["expose", "3001"]);
    expect(noContext).toMatchObject({
      exitCode: 0,
      stdout: "http://sawyer--3001.localhost:59336\n",
    });

    const threadShares = await host.harness.runCli(["shares", "--json"], {
      threadId: "thread-air",
    });
    expect(JSON.parse(threadShares.stdout ?? "")).toEqual({
      host: {
        id: REMOTE_HOST_ID,
        name: REMOTE_HOST_NAME,
        isServer: false,
      },
      shares: [
        {
          hostId: REMOTE_HOST_ID,
          hostName: REMOTE_HOST_NAME,
          port: 3000,
          url: "https://sawyer-air--3000.getbb.app",
          createdAt: expect.any(Number),
        },
      ],
    });
    const serverShares = await host.harness.runCli(["shares"]);
    expect(serverShares.stdout).toContain(
      `${SERVER_HOST_NAME} (${SERVER_HOST_ID})  3000`,
    );
    expect(serverShares.stdout).toContain(
      `${SERVER_HOST_NAME} (${SERVER_HOST_ID})  3001`,
    );
    const status = await host.harness.runCli(["status"]);
    expect(status.stdout).toContain(
      `${REMOTE_HOST_NAME} (${REMOTE_HOST_ID})  3000  https://sawyer-air--3000.getbb.app`,
    );

    const removed = await host.harness.runCli(["unexpose", "3000"], {
      threadId: "thread-air",
    });
    expect(removed.stdout).toContain(
      `Stopped sharing port 3000 on ${REMOTE_HOST_NAME} (${REMOTE_HOST_ID})`,
    );
    expect(host.harness.sharedPortDeclarations).toEqual([
      { hostId: REMOTE_HOST_ID, ports: [] },
    ]);
  });
});
