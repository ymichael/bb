import { describe, expect, it } from "vitest";
import {
  onClientSocketMessage,
  onClientSocketOpen,
} from "../../src/ws/client-protocol.js";
import { NotificationHub } from "../../src/ws/hub.js";

interface MockSocket {
  closed: Array<{ code?: number; reason?: string }>;
  messages: string[];
  close(code?: number, reason?: string): void;
  send(data: string): void;
}

function createMockSocket(): MockSocket {
  const messages: string[] = [];
  const closed: Array<{ code?: number; reason?: string }> = [];

  return {
    closed,
    messages,
    close(code?: number, reason?: string) {
      closed.push({ code, reason });
    },
    send(data: string) {
      messages.push(data);
    },
  };
}

describe("client websocket protocol", () => {
  it("subscribes valid client messages parsed through the shared schema", () => {
    const hub = new NotificationHub();
    const socket = createMockSocket();

    onClientSocketOpen(hub, socket);
    onClientSocketMessage(
      hub,
      socket,
      JSON.stringify({
        type: "subscribe",
        entity: "thread",
        id: "thread-1",
      }),
    );
    hub.notifyThread("thread-1", ["events-appended"]);

    expect(socket.closed).toHaveLength(0);
    expect(socket.messages).toHaveLength(1);
    expect(JSON.parse(socket.messages[0])).toMatchObject({
      type: "changed",
      entity: "thread",
      id: "thread-1",
      changes: ["events-appended"],
    });
  });

  it("rejects subscribe messages whose id is not a string", () => {
    const hub = new NotificationHub();
    const socket = createMockSocket();

    onClientSocketOpen(hub, socket);
    onClientSocketMessage(
      hub,
      socket,
      JSON.stringify({
        type: "subscribe",
        entity: "thread",
        id: 123,
      }),
    );
    hub.notifyThread("thread-1", ["events-appended"]);

    expect(socket.closed).toEqual([{ code: 1008, reason: "invalid-message" }]);
    expect(socket.messages).toHaveLength(0);
  });

  it("removes subscriptions after unsubscribe messages", () => {
    const hub = new NotificationHub();
    const socket = createMockSocket();

    onClientSocketOpen(hub, socket);
    onClientSocketMessage(
      hub,
      socket,
      JSON.stringify({
        type: "subscribe",
        entity: "thread",
        id: "thread-1",
      }),
    );
    onClientSocketMessage(
      hub,
      socket,
      JSON.stringify({
        type: "unsubscribe",
        entity: "thread",
        id: "thread-1",
      }),
    );
    hub.notifyThread("thread-1", ["events-appended"]);

    expect(socket.closed).toHaveLength(0);
    expect(socket.messages).toHaveLength(0);
  });

  it("rejects subscribe messages for unknown entities", () => {
    const hub = new NotificationHub();
    const socket = createMockSocket();

    onClientSocketOpen(hub, socket);
    onClientSocketMessage(
      hub,
      socket,
      JSON.stringify({
        type: "subscribe",
        entity: "bogus",
      }),
    );

    expect(socket.closed).toEqual([{ code: 1008, reason: "invalid-message" }]);
    expect(socket.messages).toHaveLength(0);
  });

  it("rejects client messages with missing required fields", () => {
    const hub = new NotificationHub();
    const socket = createMockSocket();

    onClientSocketOpen(hub, socket);
    onClientSocketMessage(
      hub,
      socket,
      JSON.stringify({
        type: "subscribe",
      }),
    );

    expect(socket.closed).toEqual([{ code: 1008, reason: "invalid-message" }]);
    expect(socket.messages).toHaveLength(0);
  });

  it("closes the socket instead of throwing on malformed JSON", () => {
    const hub = new NotificationHub();
    const socket = createMockSocket();

    onClientSocketOpen(hub, socket);

    expect(() => onClientSocketMessage(hub, socket, "{")).not.toThrow();
    expect(socket.closed).toEqual([{ code: 1008, reason: "invalid-message" }]);
  });
});
