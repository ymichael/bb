import {
  HEARTBEAT_RESPONSE,
  decodeFrame,
  encodeFrame,
} from "@bb/tunnel-contract";
import { describe, expect, it, vi } from "vitest";

const socketState = vi.hoisted(() => {
  const sent: Array<string | Buffer | Uint8Array> = [];
  return {
    sent,
    terminate: vi.fn(),
  };
});

vi.mock("ws", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ws")>();
  const { EventEmitter: MockEventEmitter } = await import("node:events");

  class FakeWebSocket extends MockEventEmitter {
    static readonly OPEN = 1;
    readyState = FakeWebSocket.OPEN;

    send(data: string | Buffer | Uint8Array): void {
      socketState.sent.push(data);
    }

    terminate(): void {
      socketState.terminate();
      this.readyState = 3;
    }
  }

  return { ...actual, WebSocket: FakeWebSocket };
});

import { WebSocket } from "ws";
import {
  type StreamOriginResult,
  TunnelSession,
} from "../src/session.js";

function createSession(
  resolveOrigin: (target: string | undefined) => StreamOriginResult,
): { session: TunnelSession; tunnel: WebSocket } {
  socketState.sent.length = 0;
  socketState.terminate.mockClear();
  const tunnel = new WebSocket("ws://tunnel.test");
  const session = new TunnelSession({
    tunnel,
    log: { warn: vi.fn() },
    resolveOrigin,
  });
  session.start();
  return { session, tunnel };
}

function emitOpenHttp(tunnel: WebSocket): void {
  const frame = encodeFrame({
    type: "open-http",
    streamId: 7,
    method: "GET",
    path: "/health",
    headers: [],
    hasBody: false,
  });
  tunnel.emit("message", Buffer.from(frame), true);
}

describe("TunnelSession disposal", () => {
  it("ignores a binary open-http frame delivered after disposal", () => {
    const resolveOrigin = vi.fn(
      (_target: string | undefined): StreamOriginResult => ({
        kind: "unregistered",
      }),
    );
    const { session, tunnel } = createSession(resolveOrigin);

    session.dispose();
    emitOpenHttp(tunnel);

    expect(resolveOrigin).not.toHaveBeenCalled();
    expect(socketState.sent).toEqual([]);
  });

  it("closes the stream when resolveOrigin throws synchronously", async () => {
    const resolveOrigin = vi.fn(
      (_target: string | undefined): StreamOriginResult => {
        throw new Error("plugin context stale");
      },
    );
    const { session, tunnel } = createSession(resolveOrigin);

    try {
      emitOpenHttp(tunnel);
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(socketState.sent).toHaveLength(1);
      const sent = socketState.sent[0];
      if (sent === undefined || typeof sent === "string") {
        throw new Error("expected one binary tunnel frame");
      }
      expect(decodeFrame(sent)).toEqual({
        type: "close-stream",
        streamId: 7,
        code: 1011,
        reason: "Error: plugin context stale",
      });
    } finally {
      session.dispose();
    }
  });

  it("ignores a heartbeat response delivered after disposal", () => {
    const { session, tunnel } = createSession(() => ({
      kind: "unregistered",
    }));

    session.dispose();

    expect(() => {
      tunnel.emit("message", Buffer.from(HEARTBEAT_RESPONSE), false);
    }).not.toThrow();
  });
});
