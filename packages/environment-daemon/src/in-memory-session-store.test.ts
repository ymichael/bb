import { beforeEach, describe, expect, it } from "vitest";
import { InMemoryEnvironmentDaemonSessionStore } from "./in-memory-session-store.js";

describe("InMemoryEnvironmentDaemonSessionStore", () => {
  let store: InMemoryEnvironmentDaemonSessionStore;

  beforeEach(() => {
    store = new InMemoryEnvironmentDaemonSessionStore();
  });

  it("initializes thread state, binds sessions, appends outbox events, and tracks acks", () => {
    expect(
      store.initializeThreadState({
        threadId: "thread-1",
        environmentDaemonId: "agent-1",
        environmentDaemonInstanceId: "instance-1",
        generation: 2,
        now: 1_000,
      }),
    ).toEqual({
      threadId: "thread-1",
      environmentDaemonId: "agent-1",
      environmentDaemonInstanceId: "instance-1",
      generation: 2,
      nextSequence: 1,
      createdAt: 1_000,
      updatedAt: 1_000,
    });

    expect(
      store.bindSession({
        threadId: "thread-1",
        sessionId: "sess-1",
        now: 1_500,
      }),
    ).toMatchObject({
      threadId: "thread-1",
      sessionId: "sess-1",
      updatedAt: 1_500,
    });

    const first = store.appendOutboxEvent({
      threadId: "thread-1",
      eventId: "evt-1",
      payload: { text: "hello" },
      emittedAt: 2_000,
    });
    const second = store.appendOutboxEvent({
      threadId: "thread-1",
      eventId: "evt-2",
      payload: { text: "world" },
      emittedAt: 3_000,
    });

    expect(first).toMatchObject({
      threadId: "thread-1",
      generation: 2,
      sequence: 1,
      eventId: "evt-1",
      payload: { text: "hello" },
    });
    expect(second.sequence).toBe(2);
    expect(store.listUnackedOutbox({ threadId: "thread-1" })).toEqual([
      expect.objectContaining({ eventId: "evt-1", sequence: 1 }),
      expect.objectContaining({ eventId: "evt-2", sequence: 2 }),
    ]);

    expect(
      store.ackOutboxThrough({
        threadId: "thread-1",
        generation: 2,
        sequence: 1,
        ackedAt: 4_000,
      }),
    ).toBe(1);
    expect(store.listUnackedOutbox({ threadId: "thread-1" })).toEqual([
      expect.objectContaining({ eventId: "evt-2", sequence: 2 }),
    ]);
    expect(store.loadSessionState("thread-1")).toMatchObject({
      threadId: "thread-1",
      lastAcked: {
        generation: 2,
        sequence: 1,
      },
      nextSequence: 3,
      updatedAt: 4_000,
    });
  });

  it("preserves existing thread state on reinitialize and bumps generation explicitly", () => {
    store.initializeThreadState({
      threadId: "thread-1",
      environmentDaemonId: "agent-1",
      environmentDaemonInstanceId: "instance-1",
      generation: 1,
      now: 1_000,
    });
    store.appendOutboxEvent({
      threadId: "thread-1",
      eventId: "evt-1",
      payload: { step: 1 },
      emittedAt: 2_000,
    });
    store.ackOutboxThrough({
      threadId: "thread-1",
      generation: 1,
      sequence: 1,
      ackedAt: 3_000,
    });

    expect(
      store.initializeThreadState({
        threadId: "thread-1",
        environmentDaemonId: "agent-2",
        environmentDaemonInstanceId: "instance-2",
        generation: 99,
        now: 4_000,
      }),
    ).toMatchObject({
      threadId: "thread-1",
      environmentDaemonId: "agent-2",
      environmentDaemonInstanceId: "instance-2",
      generation: 99,
      nextSequence: 1,
      lastAcked: {
        generation: 1,
        sequence: 1,
      },
      updatedAt: 4_000,
    });

    expect(store.bumpGeneration("thread-1", 5_000)).toMatchObject({
      generation: 100,
      nextSequence: 1,
      lastAcked: {
        generation: 1,
        sequence: 1,
      },
      updatedAt: 5_000,
    });
  });

  it("records command receipts and tracks lifecycle transitions", () => {
    const received = store.recordCommandReceived({
      commandId: "cmd-1",
      threadId: "thread-1",
      commandCursor: 1,
      commandType: "thread.start",
      now: 1_000,
    });
    expect(received).toMatchObject({
      commandId: "cmd-1",
      state: "received",
      commandCursor: 1,
      commandType: "thread.start",
      createdAt: 1_000,
      updatedAt: 1_000,
    });

    expect(store.markCommandStarted("cmd-1", 3_000)).toMatchObject({
      commandId: "cmd-1",
      state: "started",
      updatedAt: 3_000,
    });
    expect(
      store.markCommandCompleted({
        commandId: "cmd-1",
        result: { providerThreadId: "provider-1" },
        now: 4_000,
      }),
    ).toMatchObject({
      commandId: "cmd-1",
      state: "completed",
      result: { providerThreadId: "provider-1" },
      updatedAt: 4_000,
    });
    expect(store.markCommandStarted("cmd-1", 5_000)).toMatchObject({
      commandId: "cmd-1",
      state: "completed",
      updatedAt: 4_000,
    });
  });

  it("tracks command ack/result reporting state", () => {
    store.recordCommandReceived({
      commandId: "cmd-report",
      threadId: "thread-1",
      commandCursor: 7,
      commandType: "workspace.status",
      now: 1_000,
    });

    expect(store.listPendingCommandAcks("thread-1")).toEqual([
      expect.objectContaining({ commandId: "cmd-report", state: "received" }),
    ]);
    expect(store.markCommandAckReported("cmd-report", 2_000)).toMatchObject({
      commandId: "cmd-report",
      ackReportedAt: 2_000,
    });
    expect(store.listPendingCommandAcks("thread-1")).toEqual([]);

    store.markCommandStarted("cmd-report", 3_000);
    expect(store.listPendingCommandResults("thread-1")).toEqual([
      expect.objectContaining({ commandId: "cmd-report", state: "started" }),
    ]);
    expect(
      store.markCommandResultReported({
        commandId: "cmd-report",
        state: "started",
        now: 4_000,
      }),
    ).toMatchObject({
      commandId: "cmd-report",
      lastResultReportedState: "started",
      lastResultReportedAt: 4_000,
    });
    expect(store.listPendingCommandResults("thread-1")).toEqual([]);

    store.markCommandCompleted({
      commandId: "cmd-report",
      result: { ok: true },
      now: 5_000,
    });
    expect(store.listPendingCommandResults("thread-1")).toEqual([
      expect.objectContaining({ commandId: "cmd-report", state: "completed" }),
    ]);
  });

  it("rejects conflicting terminal command receipt transitions", () => {
    store.recordCommandReceived({
      commandId: "cmd-2",
      threadId: "thread-1",
      commandCursor: 2,
      commandType: "workspace.diff",
      now: 1_000,
    });
    store.markCommandCompleted({
      commandId: "cmd-2",
      result: { diff: "clean" },
      now: 2_000,
    });

    expect(() =>
      store.markCommandFailed({
        commandId: "cmd-2",
        errorCode: "boom",
        errorMessage: "should not override completed",
        now: 3_000,
      }),
    ).toThrow(
      "Invalid environment-daemon command receipt transition: completed -> failed",
    );
  });

  it("only advances the last delivered command cursor forward", () => {
    store.initializeThreadState({
      threadId: "thread-1",
      environmentDaemonId: "agent-1",
      environmentDaemonInstanceId: "instance-1",
      generation: 1,
      now: 1_000,
    });

    expect(
      store.setLastDeliveredCommandCursor({
        threadId: "thread-1",
        commandCursor: 4,
        now: 2_000,
      }),
    ).toMatchObject({
      threadId: "thread-1",
      lastDeliveredCommandCursor: 4,
      updatedAt: 2_000,
    });
    expect(
      store.setLastDeliveredCommandCursor({
        threadId: "thread-1",
        commandCursor: 2,
        now: 3_000,
      }),
    ).toMatchObject({
      threadId: "thread-1",
      lastDeliveredCommandCursor: 4,
      updatedAt: 3_000,
    });
  });
});
