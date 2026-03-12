import { beforeEach, describe, expect, it } from "vitest";
import { EnvironmentAgentSessionRuntime } from "./session-runtime.js";
import { InMemoryEnvironmentAgentSessionStore } from "./in-memory-session-store.js";

describe("EnvironmentAgentSessionRuntime", () => {
  let store: InMemoryEnvironmentAgentSessionStore;
  let runtime: EnvironmentAgentSessionRuntime;

  beforeEach(() => {
    store = new InMemoryEnvironmentAgentSessionStore();
    runtime = new EnvironmentAgentSessionRuntime({
      store,
      clock: () => 10_000,
    });
  });

  it("initializes threads, records events, and builds pending event batches", () => {
    expect(
      runtime.initializeThread({
        threadId: "thread-1",
        agentId: "agent-1",
        agentInstanceId: "instance-1",
        generation: 1,
      }),
    ).toMatchObject({
      threadId: "thread-1",
      generation: 1,
      nextSequence: 1,
    });

    runtime.bindSession({
      threadId: "thread-1",
      sessionId: "sess-1",
    });
    runtime.recordEvent({
      threadId: "thread-1",
      eventId: "evt-1",
      event: {
        type: "environment.ready",
        threadId: "thread-1",
      },
      emittedAt: 11_000,
    });
    runtime.recordEvent({
      threadId: "thread-1",
      eventId: "evt-2",
      event: {
        type: "provider.stderr",
        threadId: "thread-1",
        line: "hello",
      },
      emittedAt: 12_000,
    });

    expect(runtime.getPendingEventBatch({ threadId: "thread-1" })).toEqual({
      channelId: "thread-1",
      generation: 1,
      events: [
        {
          sequence: 1,
          eventId: "evt-1",
          emittedAt: 11_000,
          event: {
            type: "environment.ready",
            threadId: "thread-1",
          },
        },
        {
          sequence: 2,
          eventId: "evt-2",
          emittedAt: 12_000,
          event: {
            type: "provider.stderr",
            threadId: "thread-1",
            line: "hello",
          },
        },
      ],
    });

    expect(
      runtime.acknowledgeEvents({
        threadId: "thread-1",
        generation: 1,
        sequence: 2,
        ackedAt: 13_000,
      }),
    ).toBe(2);
    expect(runtime.getPendingEventBatch({ threadId: "thread-1" })).toBeUndefined();
    expect(runtime.loadThreadState("thread-1")).toMatchObject({
      threadId: "thread-1",
      lastAcked: {
        generation: 1,
        sequence: 2,
      },
    });
  });

  it("prefers the oldest unacked generation when building batches", () => {
    runtime.initializeThread({
      threadId: "thread-1",
      agentId: "agent-1",
      agentInstanceId: "instance-1",
      generation: 1,
    });
    runtime.recordEvent({
      threadId: "thread-1",
      eventId: "evt-1",
      event: {
        type: "environment.ready",
        threadId: "thread-1",
      },
      emittedAt: 11_000,
    });
    runtime.bumpGeneration("thread-1", 12_000);
    runtime.recordEvent({
      threadId: "thread-1",
      eventId: "evt-2",
      event: {
        type: "workspace.status.changed",
        threadId: "thread-1",
      },
      emittedAt: 13_000,
    });

    expect(runtime.getPendingEventBatch({ threadId: "thread-1" })).toMatchObject({
      generation: 1,
      events: [expect.objectContaining({ eventId: "evt-1" })],
    });

    runtime.acknowledgeEvents({
      threadId: "thread-1",
      generation: 1,
      sequence: 1,
      ackedAt: 14_000,
    });
    expect(runtime.getPendingEventBatch({ threadId: "thread-1" })).toMatchObject({
      generation: 2,
      events: [expect.objectContaining({ eventId: "evt-2" })],
    });
  });

  it("realigns persisted event and command cursors to the daemon view", () => {
    runtime.initializeThread({
      threadId: "thread-1",
      agentId: "agent-1",
      agentInstanceId: "instance-1",
      generation: 1,
    });
    runtime.recordEvent({
      threadId: "thread-1",
      eventId: "evt-1",
      event: {
        type: "environment.ready",
        threadId: "thread-1",
      },
      emittedAt: 11_000,
    });
    runtime.recordEvent({
      threadId: "thread-1",
      eventId: "evt-2",
      event: {
        type: "provider.stderr",
        threadId: "thread-1",
        line: "hello",
      },
      emittedAt: 12_000,
    });
    runtime.acknowledgeEvents({
      threadId: "thread-1",
      generation: 1,
      sequence: 2,
      ackedAt: 13_000,
    });
    runtime.setLastDeliveredCommandCursor({
      threadId: "thread-1",
      commandCursor: 5,
      now: 14_000,
    });

    runtime.alignEventCursor(
      "thread-1",
      {
        generation: 1,
        sequence: 0,
      },
      15_000,
    );
    runtime.alignLastDeliveredCommandCursor("thread-1", 1, 16_000);

    expect(runtime.getPendingEventBatch({ threadId: "thread-1" })).toEqual({
      channelId: "thread-1",
      generation: 1,
      events: [
        expect.objectContaining({ eventId: "evt-1", sequence: 1 }),
        expect.objectContaining({ eventId: "evt-2", sequence: 2 }),
      ],
    });
    expect(runtime.loadThreadState("thread-1")).toMatchObject({
      lastAcked: {
        generation: 1,
        sequence: 0,
      },
      lastDeliveredCommandCursor: 1,
    });
  });

  it("dedupes received commands and proxies receipt transitions", () => {
    const first = runtime.receiveCommand({
      commandId: "cmd-1",
      threadId: "thread-1",
      commandCursor: 1,
      commandType: "thread.start",
      now: 11_000,
    });
    expect(first).toMatchObject({
      ackState: "received",
      receipt: {
        commandId: "cmd-1",
        state: "received",
      },
    });

    const duplicate = runtime.receiveCommand({
      commandId: "cmd-1",
      threadId: "thread-1",
      commandCursor: 1,
      commandType: "thread.start",
      now: 12_000,
    });
    expect(duplicate).toMatchObject({
      ackState: "duplicate",
      receipt: {
        commandId: "cmd-1",
        state: "received",
      },
    });

    expect(runtime.markCommandStarted("cmd-1", 13_000)).toMatchObject({
      commandId: "cmd-1",
      state: "started",
    });
    expect(
      runtime.markCommandCompleted({
        commandId: "cmd-1",
        result: { ok: true },
        now: 14_000,
      }),
    ).toMatchObject({
      commandId: "cmd-1",
      state: "completed",
      result: { ok: true },
    });
  });

  it("exposes pending durable command ack/result reporting", () => {
    runtime.receiveCommand({
      commandId: "cmd-1",
      threadId: "thread-1",
      commandCursor: 1,
      commandType: "thread.start",
      now: 11_000,
    });

    expect(runtime.getPendingCommandAcks("thread-1")).toEqual([
      expect.objectContaining({ commandId: "cmd-1", state: "received" }),
    ]);
    expect(runtime.markCommandAckReported("cmd-1", 12_000)).toMatchObject({
      commandId: "cmd-1",
      ackReportedAt: 12_000,
    });
    expect(runtime.getPendingCommandAcks("thread-1")).toEqual([]);

    runtime.markCommandStarted("cmd-1", 13_000);
    expect(runtime.getPendingCommandResults("thread-1")).toEqual([
      expect.objectContaining({ commandId: "cmd-1", state: "started" }),
    ]);
    expect(
      runtime.markCommandResultReported({
        commandId: "cmd-1",
        state: "started",
        now: 14_000,
      }),
    ).toMatchObject({
      commandId: "cmd-1",
      lastResultReportedState: "started",
      lastResultReportedAt: 14_000,
    });

    runtime.markCommandCompleted({
      commandId: "cmd-1",
      result: { ok: true },
      now: 15_000,
    });
    expect(runtime.getPendingCommandResults("thread-1")).toEqual([
      expect.objectContaining({ commandId: "cmd-1", state: "completed" }),
    ]);
  });

  it("throws when persisted outbox payloads are not valid environment-agent events", () => {
    runtime.initializeThread({
      threadId: "thread-1",
      agentId: "agent-1",
      agentInstanceId: "instance-1",
      generation: 1,
    });
    runtime.recordEvent({
      threadId: "thread-1",
      eventId: "evt-1",
      event: {
        type: "environment.ready",
        threadId: "thread-1",
      },
      emittedAt: 11_000,
    });

    (
      store as unknown as {
        outboxByThread: Map<string, Array<{ eventId: string; payload: unknown }>>;
      }
    ).outboxByThread.get("thread-1")!.find((entry) => entry.eventId === "evt-1")!.payload = {
      type: "bogus",
      threadId: "thread-1",
    };

    expect(() => runtime.getPendingEventBatch({ threadId: "thread-1" })).toThrow(
      "Invalid persisted environment-agent outbox payload for thread thread-1",
    );
  });
});
