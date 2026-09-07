import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { ShareHostResolver } from "./hosts.js";
import { ShareRegistry } from "./shares.js";

interface FakeWebSocketOptions {
  handshakeTimeout?: number;
}

interface FakeTunnelSocket {
  readyState: number;
  emit(eventName: string, ...args: unknown[]): boolean;
  terminate(): void;
}

const fakeWebSockets = vi.hoisted(() => ({
  instances: [] as FakeTunnelSocket[],
  options: [] as FakeWebSocketOptions[],
}));

vi.mock("ws", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ws")>();
  const { EventEmitter } = await import("node:events");

  class FakeWebSocket extends EventEmitter {
    readyState = 0;

    constructor(_url: unknown, options: FakeWebSocketOptions) {
      super();
      fakeWebSockets.instances.push(this);
      fakeWebSockets.options.push(options);
    }

    terminate(): void {
      this.readyState = 3;
    }
  }

  return { ...actual, WebSocket: FakeWebSocket };
});

import { ConnectTunnel } from "./tunnel.js";
import { DEFAULT_CONNECT_BASE_URL } from "./redeem.js";

function createTunnelFixture() {
  const fakeHost = createFakePluginHost({
    pluginId: "connect",
    sdk: {
      system: {
        config: async () => ({ primaryHostId: "host-server" }) as never,
      },
    },
  });
  const pluginBb = fakeHost.bb;
  const credential = {
    serverUrl: "https://sawyer.getbb.app",
    handle: "sawyer",
    credential: "bbcred_x",
  };
  const clearCredential = vi.fn(async () => {});
  const onStatusChange = vi.fn();
  const shares = new ShareRegistry({
    kv: {
      get: async () => undefined,
      set: async () => {},
      delete: async () => {},
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
      clear: clearCredential,
    },
    shares,
    defaultBaseUrl: DEFAULT_CONNECT_BASE_URL,
    getLoopbackBaseUrl: () => "http://127.0.0.1:38886",
    log: pluginBb.log,
    onStatusChange,
  });
  return {
    clearCredential,
    credential,
    fakeHost,
    onStatusChange,
    tunnel,
  };
}

describe("ConnectTunnel socket lifecycle", () => {
  afterEach(() => {
    fakeWebSockets.instances.length = 0;
    fakeWebSockets.options.length = 0;
  });

  it("ignores events from a socket after the tunnel stops", async () => {
    const { clearCredential, credential, fakeHost, onStatusChange, tunnel } =
      createTunnelFixture();

    try {
      await tunnel.start();
      await vi.waitFor(() => {
        expect(onStatusChange).toHaveBeenCalledTimes(2);
      });
      expect(fakeWebSockets.instances).toHaveLength(1);

      tunnel.stop();
      onStatusChange.mockClear();
      const socket = fakeWebSockets.instances[0]!;
      socket.emit("open");
      socket.emit("unexpected-response", {}, { statusCode: 401 });
      socket.emit("error", new Error("late socket error"));
      socket.emit("close", 1006, Buffer.from("late close"));

      expect(clearCredential).not.toHaveBeenCalled();
      expect(onStatusChange).not.toHaveBeenCalled();
      expect(tunnel.getCredential()).toEqual(credential);
      expect(tunnel.status().lastError).toBeNull();
    } finally {
      tunnel.stop();
      await fakeHost.harness.dispose();
    }
  });

  it("does not let a replaced socket close the current session", async () => {
    const { fakeHost, tunnel } = createTunnelFixture();

    try {
      await tunnel.start();
      expect(fakeWebSockets.instances).toHaveLength(1);
      const replacedSocket = fakeWebSockets.instances[0]!;

      tunnel.stop();
      await tunnel.start();
      expect(fakeWebSockets.instances).toHaveLength(2);
      const currentSocket = fakeWebSockets.instances[1]!;
      currentSocket.emit("open");
      expect(tunnel.status().state).toBe("connected");

      replacedSocket.emit("close", 1006, Buffer.from("late close"));

      expect(tunnel.status().state).toBe("connected");
    } finally {
      tunnel.stop();
      await fakeHost.harness.dispose();
    }
  });

  it("sets a bounded opening handshake timeout", async () => {
    const { fakeHost, tunnel } = createTunnelFixture();

    try {
      await tunnel.start();

      expect(fakeWebSockets.options).toHaveLength(1);
      expect(fakeWebSockets.options[0]?.handshakeTimeout).toEqual(
        expect.any(Number),
      );
      expect(fakeWebSockets.options[0]!.handshakeTimeout).toBeGreaterThan(0);
    } finally {
      tunnel.stop();
      await fakeHost.harness.dispose();
    }
  });

  it("retries when the handshake never completes within the deadline", async () => {
    vi.useFakeTimers();
    const { fakeHost, tunnel } = createTunnelFixture();

    try {
      await tunnel.start();
      const socket = fakeWebSockets.instances[0]!;
      const terminate = vi.spyOn(socket, "terminate");

      await vi.advanceTimersByTimeAsync(15_000);

      expect(terminate).toHaveBeenCalledOnce();
      expect(tunnel.status().lastError).toContain("handshake timed out");
      const nextRetryAt = tunnel.status().nextRetryAt;
      expect(nextRetryAt).not.toBeNull();

      await vi.advanceTimersByTimeAsync(nextRetryAt! - Date.now());
      expect(fakeWebSockets.instances).toHaveLength(2);
    } finally {
      tunnel.stop();
      vi.useRealTimers();
      await fakeHost.harness.dispose();
    }
  });

  it("retries an HTTP rejection without waiting for close", async () => {
    vi.useFakeTimers();
    const { fakeHost, tunnel } = createTunnelFixture();

    try {
      await tunnel.start();
      const socket = fakeWebSockets.instances[0]!;
      const response = { statusCode: 500, resume: vi.fn() };

      socket.emit("unexpected-response", {}, response);

      expect(response.resume).toHaveBeenCalledOnce();
      expect(tunnel.status().lastError).toBe("tunnel rejected: HTTP 500");
      const nextRetryAt = tunnel.status().nextRetryAt;
      expect(nextRetryAt).not.toBeNull();

      await vi.advanceTimersByTimeAsync(nextRetryAt! - Date.now());

      expect(fakeWebSockets.instances).toHaveLength(2);
      expect(tunnel.status().nextRetryAt).toBeNull();
    } finally {
      tunnel.stop();
      vi.useRealTimers();
      await fakeHost.harness.dispose();
    }
  });

  it("schedules one retry when rejection is followed by close", async () => {
    vi.useFakeTimers();
    const { fakeHost, tunnel } = createTunnelFixture();

    try {
      await tunnel.start();
      const socket = fakeWebSockets.instances[0]!;
      socket.emit(
        "unexpected-response",
        {},
        {
          statusCode: 500,
          resume: vi.fn(),
        },
      );
      const nextRetryAt = tunnel.status().nextRetryAt;
      expect(nextRetryAt).not.toBeNull();

      socket.emit("close", 1006, Buffer.from("late close"));

      expect(tunnel.status().nextRetryAt).toBe(nextRetryAt);
      await vi.advanceTimersByTimeAsync(nextRetryAt! - Date.now());
      expect(fakeWebSockets.instances).toHaveLength(2);
    } finally {
      tunnel.stop();
      vi.useRealTimers();
      await fakeHost.harness.dispose();
    }
  });
});
