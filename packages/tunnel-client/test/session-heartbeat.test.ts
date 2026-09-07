import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  HEARTBEAT_REQUEST,
  HEARTBEAT_RESPONSE,
} from "@bb/tunnel-contract";

const socketSpies = vi.hoisted(() => ({
  send: vi.fn(),
  terminate: vi.fn(),
}));

vi.mock("ws", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ws")>();
  const { EventEmitter } = await import("node:events");

  class FakeWebSocket extends EventEmitter {
    static readonly OPEN = 1;
    readyState = FakeWebSocket.OPEN;

    send(data: string | Buffer): void {
      socketSpies.send(data);
    }

    terminate(): void {
      socketSpies.terminate();
      this.readyState = 3;
    }
  }

  return { ...actual, WebSocket: FakeWebSocket };
});

import { WebSocket } from "ws";
import { TunnelSession } from "../src/session.js";

const HEARTBEAT_INTERVAL_MS = 20_000;

function createSession(onHeartbeatTimeout = vi.fn()) {
  const tunnel = new WebSocket("ws://tunnel.test");
  const session = new TunnelSession({
    tunnel,
    log: { warn: vi.fn() },
    resolveOrigin: () => ({ kind: "unregistered" }),
    onHeartbeatTimeout,
  });
  session.start();
  return { onHeartbeatTimeout, session, tunnel };
}

function acknowledge(tunnel: WebSocket): void {
  tunnel.emit("message", Buffer.from(HEARTBEAT_RESPONSE), false);
}

describe("TunnelSession heartbeat", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    socketSpies.send.mockClear();
    socketSpies.terminate.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("stays alive past the deadline when timely ticks receive acknowledgements", async () => {
    const { session, tunnel } = createSession();

    try {
      for (let tick = 0; tick < 5; tick += 1) {
        await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS);
        acknowledge(tunnel);
      }

      expect(socketSpies.send).toHaveBeenCalledTimes(5);
      expect(socketSpies.send).toHaveBeenLastCalledWith(HEARTBEAT_REQUEST);
      expect(socketSpies.terminate).not.toHaveBeenCalled();
    } finally {
      session.dispose();
    }
  });

  it("terminates and reports one genuine heartbeat miss", async () => {
    const { onHeartbeatTimeout, session } = createSession();

    try {
      await vi.advanceTimersByTimeAsync(4 * HEARTBEAT_INTERVAL_MS);
      await vi.advanceTimersToNextTimerAsync();

      expect(socketSpies.terminate).toHaveBeenCalledOnce();
      expect(onHeartbeatTimeout).toHaveBeenCalledOnce();
    } finally {
      session.dispose();
    }
  });

  it("lets an acknowledgement queued at decision time rescue the tunnel", async () => {
    const { onHeartbeatTimeout, session, tunnel } = createSession();

    try {
      vi.advanceTimersByTime(4 * HEARTBEAT_INTERVAL_MS);
      acknowledge(tunnel);
      await vi.advanceTimersToNextTimerAsync();

      expect(socketSpies.terminate).not.toHaveBeenCalled();
      expect(onHeartbeatTimeout).not.toHaveBeenCalled();
      expect(socketSpies.send).toHaveBeenLastCalledWith(HEARTBEAT_REQUEST);
    } finally {
      session.dispose();
    }
  });

  it("grants heartbeat grace when the timer was starved", async () => {
    const { onHeartbeatTimeout, session } = createSession();

    try {
      vi.setSystemTime(Date.now() + 90_000);
      await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS);

      expect(socketSpies.terminate).not.toHaveBeenCalled();
      expect(onHeartbeatTimeout).not.toHaveBeenCalled();
      expect(socketSpies.send).toHaveBeenCalledOnce();
      expect(socketSpies.send).toHaveBeenCalledWith(HEARTBEAT_REQUEST);
    } finally {
      session.dispose();
    }
  });

  it("makes a deferred heartbeat decision inert after disposal", async () => {
    const { onHeartbeatTimeout, session } = createSession();

    vi.advanceTimersByTime(4 * HEARTBEAT_INTERVAL_MS);
    session.dispose();
    await vi.advanceTimersToNextTimerAsync();

    expect(socketSpies.terminate).not.toHaveBeenCalled();
    expect(onHeartbeatTimeout).not.toHaveBeenCalled();
  });
});
