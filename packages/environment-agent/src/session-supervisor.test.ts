import { describe, expect, it, vi } from "vitest";
import { EnvironmentAgentRuntime } from "./runtime.js";
import { EnvironmentAgentSessionRuntime } from "./session-runtime.js";
import { InMemoryEnvironmentAgentSessionStore } from "./in-memory-session-store.js";
import { EnvironmentAgentSessionHttpClientError } from "./session-http-client.js";
import { EnvironmentAgentSessionSync } from "./session-sync.js";
import { EnvironmentAgentSessionSupervisor } from "./session-supervisor.js";
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

describe("EnvironmentAgentSessionSupervisor", () => {
  it("opens a session, persists runtime events, executes pulled commands, and reports results", async () => {
    const store = new InMemoryEnvironmentAgentSessionStore();
    const runtime = new EnvironmentAgentRuntime({ threadId: "thread-1" });
    const sessionRuntime = new EnvironmentAgentSessionRuntime({
      store,
      clock: () => 10_000,
    });
    const client = makeClientMock();
    (client.openSession as ReturnType<typeof vi.fn>).mockResolvedValue({
      protocol: "beanbag.env-agent.v1",
      type: "session_welcome",
      messageId: "msg-open",
      sessionId: "sess-1",
      sentAt: 2_000,
      payload: {
        leaseTtlMs: 30_000,
        heartbeatIntervalMs: 10_000,
        selectedTransport: "http-long-poll",
        protocolVersion: 1,
        channels: [],
      },
    });
    (client.pushEvents as ReturnType<typeof vi.fn>).mockResolvedValue({
      protocol: "beanbag.env-agent.v1",
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
    (client.pullCommands as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      protocol: "beanbag.env-agent.v1",
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
    }).mockResolvedValue({
      protocol: "beanbag.env-agent.v1",
      type: "command_batch",
      messageId: "msg-cmd-empty",
      sessionId: "sess-1",
      sentAt: 5_000,
      payload: { commands: [] },
    });
    (client.acknowledgeCommands as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    (client.sendCommandResult as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

    vi.spyOn(runtime, "executeCommand").mockResolvedValue({
      protocolVersion: 1,
      commandId: "cmd-1",
      idempotencyKey: "cmd-1",
      state: "accepted",
      acknowledgedAt: 4_500,
      latestSequence: 1,
      result: { ok: true },
    });

    const sync = new EnvironmentAgentSessionSync({ runtime: sessionRuntime, client });
    const supervisor = new EnvironmentAgentSessionSupervisor({
      threadId: "thread-1",
      runtime,
      sessionRuntime,
      sessionSync: sync,
      pollIntervalMs: 5,
    });

    await supervisor.start();
    runtime.appendEvent({ type: "environment.ready", threadId: "thread-1" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    await supervisor.close();
    await runtime.shutdown();

    expect(client.openSession).toHaveBeenCalledTimes(1);
    expect(client.pushEvents).toHaveBeenCalled();
    expect(client.acknowledgeCommands).toHaveBeenCalledWith("sess-1", {
      commands: [
        {
          commandId: "cmd-1",
          channelId: "thread-1",
          state: "received",
        },
      ],
      deliveredThrough: 1,
    });
    expect(client.sendCommandResult).toHaveBeenCalledWith(
      "sess-1",
      expect.objectContaining({ commandId: "cmd-1", state: "started" }),
    );
    expect(client.sendCommandResult).toHaveBeenCalledWith(
      "sess-1",
      expect.objectContaining({ commandId: "cmd-1", state: "completed" }),
    );
    expect(client.closeSession).toHaveBeenCalledWith("sess-1", "agent_shutdown");
  });

  it("reopens the session after an inactive-session heartbeat failure", async () => {
    vi.useFakeTimers();
    try {
      const store = new InMemoryEnvironmentAgentSessionStore();
      const runtime = new EnvironmentAgentRuntime({ threadId: "thread-1" });
      const sessionRuntime = new EnvironmentAgentSessionRuntime({
        store,
        clock: () => 10_000,
      });
      const client = makeClientMock();
      (client.openSession as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({
          protocol: "beanbag.env-agent.v1",
          type: "session_welcome",
          messageId: "msg-open-1",
          sessionId: "sess-1",
          sentAt: 2_000,
          payload: {
            leaseTtlMs: 30_000,
            heartbeatIntervalMs: 5,
            selectedTransport: "http-long-poll",
            protocolVersion: 1,
            channels: [],
          },
        })
        .mockResolvedValueOnce({
          protocol: "beanbag.env-agent.v1",
          type: "session_welcome",
          messageId: "msg-open-2",
          sessionId: "sess-2",
          sentAt: 3_000,
          payload: {
            leaseTtlMs: 30_000,
            heartbeatIntervalMs: 5,
            selectedTransport: "http-long-poll",
            protocolVersion: 1,
            channels: [],
          },
        });
      (client.heartbeat as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new EnvironmentAgentSessionHttpClientError({
          message:
            "Unexpected daemon response 409 (expected 204): Environment-agent session sess-1 is not active",
          status: 409,
          code: "inactive_session",
        }))
        .mockResolvedValue(undefined);
      (client.pullCommands as ReturnType<typeof vi.fn>).mockResolvedValue({
        protocol: "beanbag.env-agent.v1",
        type: "command_batch",
        messageId: "msg-cmd-empty",
        sessionId: "sess-1",
        sentAt: 5_000,
        payload: { commands: [] },
      });
      (client.closeSession as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

      const sync = new EnvironmentAgentSessionSync({ runtime: sessionRuntime, client });
      const onError = vi.fn();
      const supervisor = new EnvironmentAgentSessionSupervisor({
        threadId: "thread-1",
        runtime,
        sessionRuntime,
        sessionSync: sync,
        pollIntervalMs: 5,
        onError,
      });

      await supervisor.start();
      await vi.advanceTimersByTimeAsync(10);
      await vi.advanceTimersByTimeAsync(10);

      expect(client.openSession).toHaveBeenCalledTimes(2);
      expect(sessionRuntime.loadThreadState("thread-1")).toMatchObject({
        sessionId: "sess-2",
      });
      expect(onError).toHaveBeenCalledTimes(1);

      await supervisor.close();
      await runtime.shutdown();
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses the negotiated heartbeat interval instead of the poll interval", async () => {
    vi.useFakeTimers();
    try {
      const store = new InMemoryEnvironmentAgentSessionStore();
      const runtime = new EnvironmentAgentRuntime({ threadId: "thread-1" });
      const sessionRuntime = new EnvironmentAgentSessionRuntime({
        store,
        clock: () => 10_000,
      });
      const client = makeClientMock();
      (client.openSession as ReturnType<typeof vi.fn>).mockResolvedValue({
        protocol: "beanbag.env-agent.v1",
        type: "session_welcome",
        messageId: "msg-open",
        sessionId: "sess-1",
        sentAt: 2_000,
        payload: {
          leaseTtlMs: 30_000,
          heartbeatIntervalMs: 50,
          selectedTransport: "http-long-poll",
          protocolVersion: 1,
          channels: [],
        },
      });
      (client.heartbeat as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
      (client.pullCommands as ReturnType<typeof vi.fn>).mockResolvedValue({
        protocol: "beanbag.env-agent.v1",
        type: "command_batch",
        messageId: "msg-cmd-empty",
        sessionId: "sess-1",
        sentAt: 3_500,
        payload: { commands: [] },
      });

      const sync = new EnvironmentAgentSessionSync({ runtime: sessionRuntime, client });
      const supervisor = new EnvironmentAgentSessionSupervisor({
        threadId: "thread-1",
        runtime,
        sessionRuntime,
        sessionSync: sync,
        pollIntervalMs: 5,
      });

      await supervisor.start();

      expect(client.heartbeat).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(45);
      expect(client.heartbeat).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(10);
      expect(client.heartbeat).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(50);
      expect(client.heartbeat).toHaveBeenCalledTimes(2);

      await supervisor.close();
      await runtime.shutdown();
    } finally {
      vi.useRealTimers();
    }
  });

  it("aborts an in-flight command pull when runtime events arrive", async () => {
    vi.useFakeTimers();
    try {
      const store = new InMemoryEnvironmentAgentSessionStore();
      const runtime = new EnvironmentAgentRuntime({ threadId: "thread-1" });
      const sessionRuntime = new EnvironmentAgentSessionRuntime({
        store,
        clock: () => 10_000,
      });
      const client = makeClientMock();
      (client.openSession as ReturnType<typeof vi.fn>).mockResolvedValue({
        protocol: "beanbag.env-agent.v1",
        type: "session_welcome",
        messageId: "msg-open",
        sessionId: "sess-1",
        sentAt: 2_000,
        payload: {
          leaseTtlMs: 30_000,
          heartbeatIntervalMs: 10_000,
          selectedTransport: "http-long-poll",
          protocolVersion: 1,
          channels: [],
        },
      });
      (client.pushEvents as ReturnType<typeof vi.fn>).mockResolvedValue({
        protocol: "beanbag.env-agent.v1",
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
      let pullAborted = false;
      (client.pullCommands as ReturnType<typeof vi.fn>)
        .mockImplementationOnce(
          ({
            signal,
            waitMs,
          }: {
            signal: AbortSignal;
            waitMs: number;
          }) =>
            new Promise((_, reject) => {
              expect(waitMs).toBe(10_000);
              signal.addEventListener(
                "abort",
                () => {
                  pullAborted = true;
                  const error = new Error("Operation aborted");
                  error.name = "AbortError";
                  reject(error);
                },
                { once: true },
              );
            }),
        )
        .mockResolvedValue({
          protocol: "beanbag.env-agent.v1",
          type: "command_batch",
          messageId: "msg-cmd-empty",
          sessionId: "sess-1",
          sentAt: 3_500,
          payload: { commands: [] },
        });

      const sync = new EnvironmentAgentSessionSync({ runtime: sessionRuntime, client });
      const supervisor = new EnvironmentAgentSessionSupervisor({
        threadId: "thread-1",
        runtime,
        sessionRuntime,
        sessionSync: sync,
        pollIntervalMs: 5,
      });

      const startPromise = supervisor.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(client.pullCommands).toHaveBeenCalledTimes(1);

      runtime.appendEvent({
        type: "provider.stderr",
        threadId: "thread-1",
        line: "stderr 1",
      });

      await startPromise;
      await vi.advanceTimersByTimeAsync(10);

      expect(pullAborted).toBe(true);
      expect((client.pullCommands as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(client.pushEvents).toHaveBeenCalledWith({
        sessionId: "sess-1",
        payload: {
          batches: [
            expect.objectContaining({
              channelId: "thread-1",
              events: [
                expect.objectContaining({
                  event: {
                    type: "provider.stderr",
                    threadId: "thread-1",
                    line: "stderr 1",
                  },
                }),
              ],
            }),
          ],
        },
      });

      await supervisor.close();
      await runtime.shutdown();
    } finally {
      vi.useRealTimers();
    }
  });

  it("self-suspends after observed work is fully drained", async () => {
    vi.useFakeTimers();
    try {
      const store = new InMemoryEnvironmentAgentSessionStore();
      const runtime = new EnvironmentAgentRuntime({ threadId: "thread-1" });
      const sessionRuntime = new EnvironmentAgentSessionRuntime({
        store,
        clock: () => 10_000,
      });
      const client = makeClientMock();
      (client.openSession as ReturnType<typeof vi.fn>).mockResolvedValue({
        protocol: "beanbag.env-agent.v1",
        type: "session_welcome",
        messageId: "msg-open",
        sessionId: "sess-1",
        sentAt: 2_000,
        payload: {
          leaseTtlMs: 30_000,
          heartbeatIntervalMs: 10_000,
          selectedTransport: "http-long-poll",
          protocolVersion: 1,
          channels: [],
        },
      });
      (client.heartbeat as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
      (client.pushEvents as ReturnType<typeof vi.fn>).mockResolvedValue({
        protocol: "beanbag.env-agent.v1",
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
        protocol: "beanbag.env-agent.v1",
        type: "command_batch",
        messageId: "msg-cmd-empty",
        sessionId: "sess-1",
        sentAt: 3_500,
        payload: { commands: [] },
      });

      let supervisor: EnvironmentAgentSessionSupervisor;
      const onQuiescent = vi.fn(async () => {
        await supervisor.close();
      });
      const sync = new EnvironmentAgentSessionSync({ runtime: sessionRuntime, client });
      supervisor = new EnvironmentAgentSessionSupervisor({
        threadId: "thread-1",
        runtime,
        sessionRuntime,
        sessionSync: sync,
        pollIntervalMs: 5,
        selfSuspendDebounceMs: 20,
        onQuiescent,
      });

      await supervisor.start();
      runtime.appendEvent({
        type: "provider.event",
        threadId: "thread-1",
        method: "turn/completed",
        payload: {},
      });

      await vi.advanceTimersByTimeAsync(100);

      expect(onQuiescent).toHaveBeenCalledTimes(1);

      await supervisor.close();
      await runtime.shutdown();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not self-suspend after non-turn commands without an explicit idle transition", async () => {
    vi.useFakeTimers();
    try {
      const store = new InMemoryEnvironmentAgentSessionStore();
      const runtime = new EnvironmentAgentRuntime({ threadId: "thread-1" });
      const sessionRuntime = new EnvironmentAgentSessionRuntime({
        store,
        clock: () => 10_000,
      });
      const client = makeClientMock();
      (client.openSession as ReturnType<typeof vi.fn>).mockResolvedValue({
        protocol: "beanbag.env-agent.v1",
        type: "session_welcome",
        messageId: "msg-open",
        sessionId: "sess-1",
        sentAt: 2_000,
        payload: {
          leaseTtlMs: 30_000,
          heartbeatIntervalMs: 10_000,
          selectedTransport: "http-long-poll",
          protocolVersion: 1,
          channels: [],
        },
      });
      (client.pullCommands as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({
          protocol: "beanbag.env-agent.v1",
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
        })
        .mockResolvedValue({
          protocol: "beanbag.env-agent.v1",
          type: "command_batch",
          messageId: "msg-cmd-empty",
          sessionId: "sess-1",
          sentAt: 5_000,
          payload: { commands: [] },
        });
      (client.acknowledgeCommands as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
      (client.sendCommandResult as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

      vi.spyOn(runtime, "executeCommand").mockResolvedValue({
        protocolVersion: 1,
        commandId: "cmd-1",
        idempotencyKey: "cmd-1",
        state: "accepted",
        acknowledgedAt: 4_500,
        latestSequence: 1,
        result: { ok: true },
      });

      const onQuiescent = vi.fn(async () => undefined);
      const sync = new EnvironmentAgentSessionSync({ runtime: sessionRuntime, client });
      const supervisor = new EnvironmentAgentSessionSupervisor({
        threadId: "thread-1",
        runtime,
        sessionRuntime,
        sessionSync: sync,
        pollIntervalMs: 5,
        selfSuspendDebounceMs: 20,
        onQuiescent,
      });

      await supervisor.start();
      await vi.advanceTimersByTimeAsync(200);

      expect(onQuiescent).not.toHaveBeenCalled();

      await supervisor.close();
      await runtime.shutdown();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not self-suspend while daemon delivery is failing with pending events", async () => {
    vi.useFakeTimers();
    try {
      const store = new InMemoryEnvironmentAgentSessionStore();
      const runtime = new EnvironmentAgentRuntime({ threadId: "thread-1" });
      const sessionRuntime = new EnvironmentAgentSessionRuntime({
        store,
        clock: () => 10_000,
      });
      const client = makeClientMock();
      (client.openSession as ReturnType<typeof vi.fn>).mockResolvedValue({
        protocol: "beanbag.env-agent.v1",
        type: "session_welcome",
        messageId: "msg-open",
        sessionId: "sess-1",
        sentAt: 2_000,
        payload: {
          leaseTtlMs: 30_000,
          heartbeatIntervalMs: 10_000,
          selectedTransport: "http-long-poll",
          protocolVersion: 1,
          channels: [],
        },
      });
      (client.heartbeat as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
      (client.pushEvents as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("fetch failed"));

      const onQuiescent = vi.fn(async () => undefined);
      const sync = new EnvironmentAgentSessionSync({ runtime: sessionRuntime, client });
      const supervisor = new EnvironmentAgentSessionSupervisor({
        threadId: "thread-1",
        runtime,
        sessionRuntime,
        sessionSync: sync,
        pollIntervalMs: 5,
        selfSuspendDebounceMs: 20,
        onQuiescent,
      });

      await supervisor.start();
      runtime.appendEvent({
        type: "provider.event",
        threadId: "thread-1",
        method: "turn/completed",
        payload: {},
      });

      await vi.advanceTimersByTimeAsync(200);

      expect(sessionRuntime.getDrainSnapshot("thread-1").pendingEventCount).toBeGreaterThan(0);
      expect(onQuiescent).not.toHaveBeenCalled();

      await supervisor.close();
      await runtime.shutdown();
    } finally {
      vi.useRealTimers();
    }
  });
});
