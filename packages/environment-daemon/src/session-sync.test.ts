import { describe, expect, it, vi } from "vitest";
import { EnvironmentAgentSessionRuntime } from "./session-runtime.js";
import { InMemoryEnvironmentAgentSessionStore } from "./in-memory-session-store.js";
import { EnvironmentAgentSessionSync } from "./session-sync.js";
import type { EnvironmentAgentSessionHttpClient } from "./session-http-client.js";

function makeClientMock(): EnvironmentAgentSessionHttpClient {
  return {
    openSession: vi.fn(),
    heartbeat: vi.fn(),
    pushEvents: vi.fn(),
    pullCommands: vi.fn(),
    acknowledgeCommands: vi.fn(),
    sendCommandResult: vi.fn(),
    closeSession: vi.fn(),
  } as unknown as EnvironmentAgentSessionHttpClient;
}

describe("EnvironmentAgentSessionSync", () => {
  it("opens and binds a session, flushes events, pulls commands, and reports results", async () => {
    const store = new InMemoryEnvironmentAgentSessionStore();
    const runtime = new EnvironmentAgentSessionRuntime({
      store,
      clock: () => 10_000,
    });
    runtime.initializeThread({
      threadId: "thread-1",
      agentId: "agent-1",
      agentInstanceId: "instance-1",
      generation: 1,
      now: 1_000,
    });

    const client = makeClientMock();
    (client.openSession as ReturnType<typeof vi.fn>).mockResolvedValue({
      protocol: "bb.env-daemon.v1",
      type: "session_welcome",
      messageId: "msg-open",
      sessionId: "sess-1",
      sentAt: 2_000,
      payload: {
        leaseTtlMs: 30_000,
        heartbeatIntervalMs: 10_000,
        protocolVersion: 1,
        channels: [],
      },
    });
    (client.pushEvents as ReturnType<typeof vi.fn>).mockResolvedValue({
      protocol: "bb.env-daemon.v1",
      type: "event_ack",
      messageId: "msg-ack",
      sessionId: "sess-1",
      sentAt: 3_000,
      payload: {
        channels: [
          {
            channelId: "thread-1",
            ackedThrough: { generation: 1, sequence: 1 },
          },
        ],
      },
    });
    (client.pullCommands as ReturnType<typeof vi.fn>).mockResolvedValue({
      protocol: "bb.env-daemon.v1",
      type: "command_batch",
      messageId: "msg-cmd",
      sessionId: "sess-1",
      sentAt: 4_000,
      payload: {
        commands: [
          {
            channelId: "thread-1",
            commandCursor: 1,
            commandId: "cmd-1",
            createdAt: 3_500,
            command: {
              type: "workspace.status",
              threadId: "thread-1",
            },
          },
        ],
      },
    });
    (client.acknowledgeCommands as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    (client.sendCommandResult as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

    const sync = new EnvironmentAgentSessionSync({ runtime, client });
    const welcome = await sync.openSession({
      threadId: "thread-1",
      payload: {
        agentId: "agent-1",
        agentInstanceId: "instance-1",
        supportedProtocolVersions: [1],
        worker: {
          name: "environment-daemon",
          version: "0.0.1",
        },
        providers: [
          {
            providerId: "codex",
            adapterVersion: "0.0.1",
          },
        ],
        channels: [{ channelId: "thread-1", generation: 1 }],
      },
    });
    expect(welcome.sessionId).toBe("sess-1");
    expect(runtime.loadThreadState("thread-1")).toMatchObject({ sessionId: "sess-1" });

    runtime.recordEvent({
      threadId: "thread-1",
      eventId: "evt-1",
      event: {
        type: "environment.ready",
        threadId: "thread-1",
      },
      emittedAt: 2_500,
    });
    await expect(sync.flushPendingEvents(["thread-1"])).resolves.toEqual({
      sessionId: "sess-1",
      channelResults: [{ threadId: "thread-1", acknowledged: true }],
    });
    expect(runtime.getPendingEventBatch({ threadId: "thread-1" })).toBeUndefined();

    const pulled = await sync.pullCommands({ threadIds: ["thread-1"] });
    expect(pulled).toEqual([
      {
        threadId: "thread-1",
        commandId: "cmd-1",
        commandCursor: 1,
        command: {
          type: "workspace.status",
          threadId: "thread-1",
        },
        ackState: "received",
      },
    ]);
    expect(runtime.getPendingCommandAcks("thread-1")).toEqual([]);

    runtime.markCommandStarted("cmd-1", 5_000);
    runtime.markCommandCompleted({
      commandId: "cmd-1",
      result: { ok: true },
      now: 6_000,
    });
    await expect(sync.flushPendingCommandResults("thread-1")).resolves.toEqual([
      expect.objectContaining({
        commandId: "cmd-1",
        lastResultReportedState: "completed",
      }),
    ]);
    await expect(sync.closeSession("thread-1", "agent_shutdown")).resolves.toBeUndefined();
    expect(client.closeSession).toHaveBeenCalledWith("sess-1", "agent_shutdown");
  });

  it("returns reset cursors without acknowledging the local outbox", async () => {
    const store = new InMemoryEnvironmentAgentSessionStore();
    const runtime = new EnvironmentAgentSessionRuntime({ store, clock: () => 10_000 });
    runtime.initializeThread({
      threadId: "thread-1",
      agentId: "agent-1",
      agentInstanceId: "instance-1",
      generation: 2,
      now: 1_000,
    });
    runtime.bindSession({ threadId: "thread-1", sessionId: "sess-1", now: 2_000 });
    runtime.recordEvent({
      threadId: "thread-1",
      event: {
        type: "provider.stderr",
        threadId: "thread-1",
        line: "stderr 1",
      },
      emittedAt: 2_500,
    });

    const client = makeClientMock();
    (client.pushEvents as ReturnType<typeof vi.fn>).mockResolvedValue({
      protocol: "bb.env-daemon.v1",
      type: "event_ack",
      messageId: "msg-ack",
      sessionId: "sess-1",
      sentAt: 3_000,
      payload: {
        channels: [
          {
            channelId: "thread-1",
            ackedThrough: {
              generation: 2,
              sequence: 0,
            },
          },
        ],
      },
    });

    const sync = new EnvironmentAgentSessionSync({ runtime, client });
    await expect(sync.flushPendingEvents(["thread-1"])).resolves.toMatchObject({
      channelResults: [{
        threadId: "thread-1",
        acknowledged: false,
        resetCursor: {
          generation: 2,
          sequence: 0,
        },
      }],
    });
    expect(runtime.getPendingEventBatch({ threadId: "thread-1" })).toBeDefined();
  });

  it("applies daemon-requested event reset cursors from session welcome", async () => {
    const store = new InMemoryEnvironmentAgentSessionStore();
    const runtime = new EnvironmentAgentSessionRuntime({ store, clock: () => 10_000 });
    runtime.initializeThread({
      threadId: "thread-1",
      agentId: "agent-1",
      agentInstanceId: "instance-1",
      generation: 1,
      now: 1_000,
    });
    runtime.recordEvent({
      threadId: "thread-1",
      eventId: "evt-1",
      event: {
        type: "environment.ready",
        threadId: "thread-1",
      },
      emittedAt: 2_000,
    });
    runtime.acknowledgeEvents({
      threadId: "thread-1",
      generation: 1,
      sequence: 1,
      ackedAt: 2_500,
    });
    runtime.setLastDeliveredCommandCursor({
      threadId: "thread-1",
      commandCursor: 5,
      now: 2_600,
    });

    const client = makeClientMock();
    (client.openSession as ReturnType<typeof vi.fn>).mockResolvedValue({
      protocol: "bb.env-daemon.v1",
      type: "session_welcome",
      messageId: "msg-open",
      sessionId: "sess-1",
      sentAt: 3_000,
      payload: {
        leaseTtlMs: 30_000,
        heartbeatIntervalMs: 10_000,
        protocolVersion: 1,
        channels: [
          {
            channelId: "thread-1",
            applyFrom: {
              generation: 1,
              sequenceExclusive: 0,
            },
          },
        ],
      },
    });

    const sync = new EnvironmentAgentSessionSync({ runtime, client });
    await expect(sync.openSession({
      threadId: "thread-1",
      payload: {
        agentId: "agent-1",
        agentInstanceId: "instance-1",
        supportedProtocolVersions: [1],
        channels: [{ channelId: "thread-1", generation: 1 }],
      },
    })).resolves.toMatchObject({ sessionId: "sess-1" });

    expect(runtime.getPendingEventBatch({ threadId: "thread-1" })).toEqual({
      channelId: "thread-1",
      generation: 1,
      events: [expect.objectContaining({ eventId: "evt-1", sequence: 1 })],
    });
    expect(runtime.loadThreadState("thread-1")).toMatchObject({
      sessionId: "sess-1",
      lastAcked: {
        generation: 1,
        sequence: 0,
      },
    });
  });

  it("initializes a newly attached shared channel from pulled commands", async () => {
    const store = new InMemoryEnvironmentAgentSessionStore();
    const runtime = new EnvironmentAgentSessionRuntime({
      store,
      clock: () => 10_000,
    });
    runtime.initializeThread({
      threadId: "thread-1",
      agentId: "agent-1",
      agentInstanceId: "instance-1",
      generation: 1,
      now: 1_000,
    });
    runtime.bindSession({
      threadId: "thread-1",
      sessionId: "sess-1",
      now: 1_500,
    });

    const client = makeClientMock();
    (client.pullCommands as ReturnType<typeof vi.fn>).mockResolvedValue({
      protocol: "bb.env-daemon.v1",
      type: "command_batch",
      messageId: "msg-cmd",
      sessionId: "sess-1",
      sentAt: 2_000,
      payload: {
        commands: [
          {
            channelId: "thread-2",
            commandCursor: 1,
            commandId: "cmd-2",
            createdAt: 1_900,
            command: {
              type: "provider.ensure",
              threadId: "thread-2",
              provider: "codex",
            },
          },
        ],
      },
    });
    (client.acknowledgeCommands as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

    const sync = new EnvironmentAgentSessionSync({ runtime, client });
    await expect(sync.pullCommands({ threadIds: ["thread-1"] })).resolves.toEqual([
      {
        threadId: "thread-2",
        commandId: "cmd-2",
        commandCursor: 1,
        command: {
          type: "provider.ensure",
          threadId: "thread-2",
          provider: "codex",
        },
        ackState: "received",
      },
    ]);

    expect(runtime.loadThreadState("thread-2")).toMatchObject({
      threadId: "thread-2",
      agentId: "agent-1",
      agentInstanceId: "instance-1",
      sessionId: "sess-1",
    });
    expect(client.acknowledgeCommands).toHaveBeenCalledWith("sess-1", {
      commands: [
        {
          commandId: "cmd-2",
          channelId: "thread-2",
          state: "received",
        },
      ],
    });
  });
});
