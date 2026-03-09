import { describe, it, expect, vi, beforeEach } from "vitest";
import { SYSTEM_CHANGE_KINDS, THREAD_CHANGE_KINDS } from "@beanbag/agent-core";
import { WSManager } from "../ws.js";

// Minimal mock WebSocket that emulates the 'ws' library interface
function createMockSocket(readyState = 1 /* OPEN */): any {
  const listeners = new Map<string, Function[]>();
  return {
    readyState,
    send: vi.fn(),
    close: vi.fn(),
    on(event: string, handler: Function) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event)!.push(handler);
    },
    // Helper to trigger events in tests
    _emit(event: string, ...args: any[]) {
      const handlers = listeners.get(event) ?? [];
      for (const h of handlers) h(...args);
    },
  };
}

describe("WSManager", () => {
  let wsManager: WSManager;
  const defaultChangedMsg = JSON.stringify({
    type: "changed",
    entity: "thread",
    changes: [...THREAD_CHANGE_KINDS],
  });

  beforeEach(() => {
    wsManager = new WSManager();
  });

  describe("handleConnection() + subscribe/unsubscribe", () => {
    it("registers a socket and processes subscribe messages", () => {
      const socket = createMockSocket();
      wsManager.handleConnection(socket);

      // Subscribe to "thread" entity
      socket._emit(
        "message",
        Buffer.from(JSON.stringify({ type: "subscribe", entity: "thread" })),
      );

      // Broadcast should reach the subscriber
      wsManager.broadcast("thread");
      expect(socket.send).toHaveBeenCalledWith(
        defaultChangedMsg,
      );
    });

    it("processes subscribe with specific id", () => {
      const socket = createMockSocket();
      wsManager.handleConnection(socket);

      socket._emit(
        "message",
        Buffer.from(
          JSON.stringify({ type: "subscribe", entity: "thread", id: "t1" }),
        ),
      );

      // Should receive broadcast for thread:t1
      wsManager.broadcast("thread", "t1");
      expect(socket.send).toHaveBeenCalledWith(
        JSON.stringify({
          type: "changed",
          entity: "thread",
          id: "t1",
          changes: [...THREAD_CHANGE_KINDS],
        }),
      );

      // Should NOT receive broadcast for a different thread id
      socket.send.mockClear();
      wsManager.broadcast("thread", "t2");
      expect(socket.send).not.toHaveBeenCalled();
    });

    it("processes unsubscribe messages", () => {
      const socket = createMockSocket();
      wsManager.handleConnection(socket);

      // Subscribe then unsubscribe
      socket._emit(
        "message",
        Buffer.from(JSON.stringify({ type: "subscribe", entity: "thread" })),
      );
      socket._emit(
        "message",
        Buffer.from(JSON.stringify({ type: "unsubscribe", entity: "thread" })),
      );

      wsManager.broadcast("thread");
      expect(socket.send).not.toHaveBeenCalled();
    });

    it("ignores malformed messages", () => {
      const socket = createMockSocket();
      wsManager.handleConnection(socket);

      // Should not throw on invalid JSON
      socket._emit("message", Buffer.from("not json"));
      socket._emit("message", Buffer.from("{}"));

      // Manager should still function
      wsManager.broadcast("thread");
      expect(socket.send).not.toHaveBeenCalled();
    });
  });

  describe("broadcast()", () => {
    it("sends to entity subscribers and entity+id subscribers", () => {
      const entitySub = createMockSocket();
      const idSub = createMockSocket();

      wsManager.handleConnection(entitySub);
      wsManager.handleConnection(idSub);

      entitySub._emit(
        "message",
        Buffer.from(JSON.stringify({ type: "subscribe", entity: "thread" })),
      );
      idSub._emit(
        "message",
        Buffer.from(
          JSON.stringify({ type: "subscribe", entity: "thread", id: "t1" }),
        ),
      );

      wsManager.broadcast("thread", "t1");

      // Both should receive the message
      const expected = JSON.stringify({
        type: "changed",
        entity: "thread",
        id: "t1",
        changes: [...THREAD_CHANGE_KINDS],
      });
      expect(entitySub.send).toHaveBeenCalledWith(expected);
      expect(idSub.send).toHaveBeenCalledWith(expected);
    });

    it("does not send to non-OPEN sockets", () => {
      const closedSocket = createMockSocket(3 /* CLOSED */);
      wsManager.handleConnection(closedSocket);

      closedSocket._emit(
        "message",
        Buffer.from(JSON.stringify({ type: "subscribe", entity: "thread" })),
      );

      wsManager.broadcast("thread");
      expect(closedSocket.send).not.toHaveBeenCalled();
    });

    it("deduplicates recipients when subscribed to both entity and entity+id", () => {
      const socket = createMockSocket();
      wsManager.handleConnection(socket);

      // Subscribe to both entity-level and specific id
      socket._emit(
        "message",
        Buffer.from(JSON.stringify({ type: "subscribe", entity: "thread" })),
      );
      socket._emit(
        "message",
        Buffer.from(
          JSON.stringify({ type: "subscribe", entity: "thread", id: "t1" }),
        ),
      );

      wsManager.broadcast("thread", "t1");

      // Should only send once (deduplicated via Set)
      expect(socket.send).toHaveBeenCalledTimes(1);
    });

    it("does not send entity-only broadcast to id-specific subscribers", () => {
      const idOnlySub = createMockSocket();
      wsManager.handleConnection(idOnlySub);

      idOnlySub._emit(
        "message",
        Buffer.from(
          JSON.stringify({ type: "subscribe", entity: "thread", id: "t1" }),
        ),
      );

      // Entity-level broadcast without id
      wsManager.broadcast("thread");
      expect(idOnlySub.send).not.toHaveBeenCalled();
    });

    it("broadcasts system changes to system subscribers", () => {
      const socket = createMockSocket();
      wsManager.handleConnection(socket);

      socket._emit(
        "message",
        Buffer.from(JSON.stringify({ type: "subscribe", entity: "system" })),
      );

      wsManager.broadcast("system");
      expect(socket.send).toHaveBeenCalledWith(
        JSON.stringify({
          type: "changed",
          entity: "system",
          changes: [...SYSTEM_CHANGE_KINDS],
        }),
      );
    });
  });

  describe("connection cleanup", () => {
    it("removes subscriptions on close", () => {
      const socket = createMockSocket();
      wsManager.handleConnection(socket);

      socket._emit(
        "message",
        Buffer.from(JSON.stringify({ type: "subscribe", entity: "thread" })),
      );

      // Close the socket
      socket._emit("close");

      // Should no longer receive broadcasts
      wsManager.broadcast("thread");
      expect(socket.send).not.toHaveBeenCalled();
    });

    it("removes subscriptions on error", () => {
      const socket = createMockSocket();
      wsManager.handleConnection(socket);

      socket._emit(
        "message",
        Buffer.from(JSON.stringify({ type: "subscribe", entity: "thread" })),
      );

      socket._emit("error");

      wsManager.broadcast("thread");
      expect(socket.send).not.toHaveBeenCalled();
    });

    it("does not affect other sockets when one disconnects", () => {
      const socket1 = createMockSocket();
      const socket2 = createMockSocket();
      wsManager.handleConnection(socket1);
      wsManager.handleConnection(socket2);

      socket1._emit(
        "message",
        Buffer.from(JSON.stringify({ type: "subscribe", entity: "thread" })),
      );
      socket2._emit(
        "message",
        Buffer.from(JSON.stringify({ type: "subscribe", entity: "thread" })),
      );

      // Disconnect socket1
      socket1._emit("close");

      // socket2 should still receive broadcasts
      wsManager.broadcast("thread");
      expect(socket1.send).not.toHaveBeenCalled();
      expect(socket2.send).toHaveBeenCalledTimes(1);
    });
  });

  describe("close()", () => {
    it("closes all connections and clears state", () => {
      const socket1 = createMockSocket();
      const socket2 = createMockSocket();
      wsManager.handleConnection(socket1);
      wsManager.handleConnection(socket2);

      socket1._emit(
        "message",
        Buffer.from(JSON.stringify({ type: "subscribe", entity: "thread" })),
      );
      socket2._emit(
        "message",
        Buffer.from(JSON.stringify({ type: "subscribe", entity: "thread" })),
      );

      wsManager.close();

      expect(socket1.close).toHaveBeenCalled();
      expect(socket2.close).toHaveBeenCalled();

      // After close, broadcasts should not reach anyone
      socket1.send.mockClear();
      socket2.send.mockClear();
      wsManager.broadcast("thread");
      wsManager.broadcast("thread");
      expect(socket1.send).not.toHaveBeenCalled();
      expect(socket2.send).not.toHaveBeenCalled();
    });
  });
});
