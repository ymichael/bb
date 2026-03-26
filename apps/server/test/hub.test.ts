import { describe, expect, it } from "vitest";
import { NotificationHub } from "../src/ws/hub.js";

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

describe("NotificationHub", () => {
  it("subscribes clients and delivers thread notifications", () => {
    const hub = new NotificationHub();
    const socket = createMockSocket();

    hub.subscribe(socket, "thread", "thread-1");
    hub.notifyThread("thread-1", ["events-appended"]);

    expect(socket.messages).toHaveLength(1);
    expect(JSON.parse(socket.messages[0])).toMatchObject({
      type: "changed",
      entity: "thread",
      id: "thread-1",
      changes: ["events-appended"],
    });
  });

  it("stops notifications after unsubscribe", () => {
    const hub = new NotificationHub();
    const socket = createMockSocket();

    hub.subscribe(socket, "thread", "thread-1");
    hub.unsubscribe(socket, "thread", "thread-1");
    hub.notifyThread("thread-1", ["status-changed"]);

    expect(socket.messages).toHaveLength(0);
  });

  it("cleans up subscriptions on client disconnect", () => {
    const hub = new NotificationHub();
    const socket = createMockSocket();

    hub.subscribe(socket, "thread", "thread-1");
    hub.subscribe(socket, "project", "project-1");
    hub.unregisterClient(socket);
    hub.notifyThread("thread-1", ["events-appended"]);
    hub.notifyProject("project-1", ["threads-changed"]);

    expect(socket.messages).toHaveLength(0);
  });

  it("notifies only the daemon socket registered for the host", () => {
    const hub = new NotificationHub();
    const socket1 = createMockSocket();
    const socket2 = createMockSocket();

    hub.registerDaemon("session-1", "host-1", socket1);
    hub.registerDaemon("session-2", "host-2", socket2);
    hub.notifyCommand("host-1");

    expect(socket1.messages).toHaveLength(1);
    expect(JSON.parse(socket1.messages[0])).toEqual({
      type: "commands-available",
    });
    expect(socket2.messages).toHaveLength(0);
  });

  it("treats daemon notifications for unknown hosts as a no-op", () => {
    const hub = new NotificationHub();
    const socket = createMockSocket();

    hub.registerDaemon("session-1", "host-1", socket);

    expect(() => hub.notifyDaemon("nonexistent-session-id")).not.toThrow();
    expect(socket.messages).toHaveLength(0);
  });

  it("notifies all clients subscribed to the same thread", () => {
    const hub = new NotificationHub();
    const socket1 = createMockSocket();
    const socket2 = createMockSocket();
    const socket3 = createMockSocket();

    hub.subscribe(socket1, "thread", "thread-1");
    hub.subscribe(socket2, "thread", "thread-1");
    hub.subscribe(socket3, "thread", "thread-2");
    hub.notifyThread("thread-1", ["status-changed"]);

    expect(socket1.messages).toHaveLength(1);
    expect(socket2.messages).toHaveLength(1);
    expect(socket3.messages).toHaveLength(0);
  });

  it("resolves command waiters and command-result waiters", async () => {
    const hub = new NotificationHub();

    const commandWait = hub.waitForCommands("host-1", 1_000);
    const resultWait = hub.waitForCommandResult("cmd-1", 1_000);

    setTimeout(() => {
      hub.notifyCommand("host-1");
      hub.recordCommandResult("cmd-1", { ok: true });
    }, 0);

    await expect(commandWait).resolves.toBe(true);
    await expect(resultWait).resolves.toEqual({ ok: true });
  });

  it("rejects command-result waiters on timeout", async () => {
    const hub = new NotificationHub();
    await expect(hub.waitForCommandResult("cmd-timeout", 1)).rejects.toThrow(
      "Timed out waiting for command result",
    );
  });

  it("keeps subscription bookkeeping consistent across repeated changes", () => {
    const hub = new NotificationHub();
    const socket = createMockSocket();

    for (let index = 0; index < 20; index += 1) {
      hub.subscribe(socket, "thread", "thread-1");
      hub.unsubscribe(socket, "thread", "thread-1");
    }
    hub.subscribe(socket, "thread", "thread-1");
    hub.notifyThread("thread-1", ["events-appended"]);

    expect(socket.messages).toHaveLength(1);

    hub.unregisterClient(socket);
    hub.notifyThread("thread-1", ["events-appended"]);

    expect(socket.messages).toHaveLength(1);
  });
});
