import { describe, expect, it, vi } from "vitest";
import { EnvironmentDaemonRuntime } from "./runtime.js";
import { EnvironmentDaemonSessionRuntime } from "./session-runtime.js";
import { InMemoryEnvironmentDaemonSessionStore } from "./in-memory-session-store.js";
import { EnvironmentDaemonSessionHttpClientError } from "./session-http-client.js";
import { EnvironmentDaemonSessionSync } from "./session-sync.js";
import { EnvironmentDaemonSessionSupervisor } from "./session-supervisor.js";
import type { EnvironmentDaemonSessionHttpClient } from "./session-http-client.js";

function makeClientMock(): EnvironmentDaemonSessionHttpClient {
  return {
    openSession: vi.fn(),
    heartbeat: vi.fn(),
    pushEvents: vi.fn(),
    pullCommands: vi.fn(),
    acknowledgeCommands: vi.fn(),
    sendCommandResult: vi.fn(),
    closeSession: vi.fn(),
  } as unknown as EnvironmentDaemonSessionHttpClient;
}

describe("EnvironmentDaemonSessionSupervisor", () => {
  it("can open an environment session before any thread channel is known", async () => {
    const store = new InMemoryEnvironmentDaemonSessionStore();
    const runtime = new EnvironmentDaemonRuntime({});
    const sessionRuntime = new EnvironmentDaemonSessionRuntime({
      store,
      clock: () => 10_000,
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
    (client.pullCommands as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        protocol: "bb.env-daemon.v1",
        type: "command_batch",
        messageId: "msg-cmd",
        sessionId: "sess-1",
        sentAt: 3_000,
        payload: {
          commands: [
            {
              channelId: "thread-1",
              commandCursor: 1,
              commandId: "cmd-1",
              createdAt: 2_500,
              command: {
                type: "workspace.status",
                threadId: "thread-1",
              },
            },
          ],
        },
      })
      .mockResolvedValue({
        protocol: "bb.env-daemon.v1",
        type: "command_batch",
        messageId: "msg-cmd-empty",
        sessionId: "sess-1",
        sentAt: 3_500,
        payload: { commands: [] },
      });
    (client.acknowledgeCommands as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    (client.sendCommandResult as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    (client.closeSession as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

    vi.spyOn(runtime, "executeCommand").mockResolvedValue({
      protocolVersion: 1,
      commandId: "cmd-1",
      idempotencyKey: "cmd-1",
      state: "accepted",
      acknowledgedAt: 3_250,
      latestSequence: 0,
      result: { ok: true },
    });

    const sync = new EnvironmentDaemonSessionSync({ runtime: sessionRuntime, client });
    const supervisor = new EnvironmentDaemonSessionSupervisor({
      environmentId: "env-1",
      runtime,
      sessionRuntime,
      sessionSync: sync,
      pollIntervalMs: 5,
    });

    await supervisor.start();
    await new Promise((resolve) => setTimeout(resolve, 25));
    await supervisor.close();

    expect(client.openSession).toHaveBeenCalledWith(
      expect.objectContaining({ channels: [] }),
    );
    expect(runtime.executeCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        command: {
          type: "workspace.status",
          threadId: "thread-1",
        },
      }),
    );
    expect(sessionRuntime.loadThreadState("thread-1")).toMatchObject({
      sessionId: "sess-1",
    });
  });

  it("opens a session, persists runtime events, executes pulled commands, and reports results", async () => {
    const store = new InMemoryEnvironmentDaemonSessionStore();
    const runtime = new EnvironmentDaemonRuntime({ threadId: "thread-1" });
    const sessionRuntime = new EnvironmentDaemonSessionRuntime({
      store,
      clock: () => 10_000,
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
        channels: [
          {
            channelId: "thread-1",
            applyFrom: { generation: 1, sequenceExclusive: 0 },
          },
        ],
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
    (client.pullCommands as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
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
    }).mockResolvedValue({
      protocol: "bb.env-daemon.v1",
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

    const sync = new EnvironmentDaemonSessionSync({ runtime: sessionRuntime, client });
    const supervisor = new EnvironmentDaemonSessionSupervisor({
      environmentId: "env-1",
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

  it("does not derive afterCursor from the first thread in a multi-channel session", async () => {
    const store = new InMemoryEnvironmentDaemonSessionStore();
    const runtime = new EnvironmentDaemonRuntime({});
    const sessionRuntime = new EnvironmentDaemonSessionRuntime({
      store,
      clock: () => 10_000,
    });
    sessionRuntime.initializeThread({
      threadId: "thread-1",
      agentId: "agent-1",
      agentInstanceId: "instance-1",
      generation: 3,
    });
    sessionRuntime.initializeThread({
      threadId: "thread-2",
      agentId: "agent-1",
      agentInstanceId: "instance-1",
      generation: 7,
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
        channels: [
          {
            channelId: "thread-1",
            applyFrom: { generation: 3, sequenceExclusive: 0 },
          },
          {
            channelId: "thread-2",
            applyFrom: { generation: 7, sequenceExclusive: 0 },
          },
        ],
      },
    });
    (client.pullCommands as ReturnType<typeof vi.fn>).mockResolvedValue({
      protocol: "bb.env-daemon.v1",
      type: "command_batch",
      messageId: "msg-cmd-empty",
      sessionId: "sess-1",
      sentAt: 3_000,
      payload: { commands: [] },
    });
    (client.closeSession as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

    const sync = new EnvironmentDaemonSessionSync({ runtime: sessionRuntime, client });
    const supervisor = new EnvironmentDaemonSessionSupervisor({
      environmentId: "env-1",
      runtime,
      sessionRuntime,
      sessionSync: sync,
      pollIntervalMs: 5,
    });

    await supervisor.start();
    await new Promise((resolve) => setTimeout(resolve, 25));
    await supervisor.close();

    expect(client.pullCommands).toHaveBeenCalled();
    for (const [args] of (client.pullCommands as ReturnType<typeof vi.fn>).mock.calls) {
      expect(args).not.toHaveProperty("afterCursor");
    }
  });

  it("reopens the session after an inactive-session heartbeat failure", async () => {
    vi.useFakeTimers();
    try {
      const store = new InMemoryEnvironmentDaemonSessionStore();
      const runtime = new EnvironmentDaemonRuntime({ threadId: "thread-1" });
      const sessionRuntime = new EnvironmentDaemonSessionRuntime({
        store,
        clock: () => 10_000,
      });
      const client = makeClientMock();
      (client.openSession as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({
          protocol: "bb.env-daemon.v1",
          type: "session_welcome",
          messageId: "msg-open-1",
          sessionId: "sess-1",
          sentAt: 2_000,
          payload: {
            leaseTtlMs: 30_000,
            heartbeatIntervalMs: 5,
            protocolVersion: 1,
            channels: [
              {
                channelId: "thread-1",
                applyFrom: { generation: 1, sequenceExclusive: 0 },
              },
            ],
          },
        })
        .mockResolvedValueOnce({
          protocol: "bb.env-daemon.v1",
          type: "session_welcome",
          messageId: "msg-open-2",
          sessionId: "sess-2",
          sentAt: 3_000,
          payload: {
            leaseTtlMs: 30_000,
            heartbeatIntervalMs: 5,
            protocolVersion: 1,
            channels: [
              {
                channelId: "thread-1",
                applyFrom: { generation: 1, sequenceExclusive: 0 },
              },
            ],
          },
        });
      (client.heartbeat as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new EnvironmentDaemonSessionHttpClientError({
          message:
            "Unexpected daemon response 409 (expected 204): Environment-daemon session sess-1 is not active",
          status: 409,
          code: "inactive_session",
        }))
        .mockResolvedValue(undefined);
      (client.pullCommands as ReturnType<typeof vi.fn>).mockResolvedValue({
        protocol: "bb.env-daemon.v1",
        type: "command_batch",
        messageId: "msg-cmd-empty",
        sessionId: "sess-1",
        sentAt: 5_000,
        payload: { commands: [] },
      });
      (client.closeSession as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

      const sync = new EnvironmentDaemonSessionSync({ runtime: sessionRuntime, client });
      const onError = vi.fn();
      const supervisor = new EnvironmentDaemonSessionSupervisor({
        environmentId: "env-1",
        runtime,
        sessionRuntime,
        sessionSync: sync,
        pollIntervalMs: 5,
        onError,
      });

      await supervisor.start();
      await vi.advanceTimersByTimeAsync(120);
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
      const store = new InMemoryEnvironmentDaemonSessionStore();
      const runtime = new EnvironmentDaemonRuntime({ threadId: "thread-1" });
      const sessionRuntime = new EnvironmentDaemonSessionRuntime({
        store,
        clock: () => 10_000,
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
          heartbeatIntervalMs: 50,
          protocolVersion: 1,
          channels: [
            {
              channelId: "thread-1",
              applyFrom: { generation: 1, sequenceExclusive: 0 },
            },
          ],
        },
      });
      (client.heartbeat as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
      (client.pullCommands as ReturnType<typeof vi.fn>).mockResolvedValue({
        protocol: "bb.env-daemon.v1",
        type: "command_batch",
        messageId: "msg-cmd-empty",
        sessionId: "sess-1",
        sentAt: 3_500,
        payload: { commands: [] },
      });

      const sync = new EnvironmentDaemonSessionSync({ runtime: sessionRuntime, client });
      const supervisor = new EnvironmentDaemonSessionSupervisor({
        environmentId: "env-1",
        runtime,
        sessionRuntime,
        sessionSync: sync,
        pollIntervalMs: 5,
        eventFlushDebounceMs: 0,
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

  it("resets retry backoff when poked after a failed heartbeat", async () => {
    vi.useFakeTimers();
    try {
      const store = new InMemoryEnvironmentDaemonSessionStore();
      const runtime = new EnvironmentDaemonRuntime({ threadId: "thread-1" });
      const sessionRuntime = new EnvironmentDaemonSessionRuntime({
        store,
        clock: () => 10_000,
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
          heartbeatIntervalMs: 5,
          protocolVersion: 1,
          channels: [
            {
              channelId: "thread-1",
              applyFrom: { generation: 1, sequenceExclusive: 0 },
            },
          ],
        },
      });
      (client.heartbeat as ReturnType<typeof vi.fn>)
        .mockRejectedValueOnce(new Error("daemon unavailable"))
        .mockResolvedValue(undefined);
      (client.pullCommands as ReturnType<typeof vi.fn>).mockResolvedValue({
        protocol: "bb.env-daemon.v1",
        type: "command_batch",
        messageId: "msg-cmd-empty",
        sessionId: "sess-1",
        sentAt: 5_000,
        payload: { commands: [] },
      });
      (client.closeSession as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

      const sync = new EnvironmentDaemonSessionSync({ runtime: sessionRuntime, client });
      const supervisor = new EnvironmentDaemonSessionSupervisor({
        environmentId: "env-1",
        runtime,
        sessionRuntime,
        sessionSync: sync,
        pollIntervalMs: 100,
      });

      await supervisor.start();
      await vi.advanceTimersByTimeAsync(120);

      expect(runtime.getStatusSnapshot()).toMatchObject({
        connectedToServer: false,
        deliveryState: "retrying",
        retryAttemptCount: 1,
      });

      supervisor.poke();
      expect(runtime.getStatusSnapshot()).toMatchObject({
        retryAttemptCount: 0,
      });

      await vi.advanceTimersByTimeAsync(0);
      expect(runtime.getStatusSnapshot()).toMatchObject({
        connectedToServer: true,
        deliveryState: "healthy",
        retryAttemptCount: 0,
      });

      await supervisor.close();
      await runtime.shutdown();
    } finally {
      vi.useRealTimers();
    }
  });

  it("aborts an in-flight command pull when runtime events arrive", async () => {
    vi.useFakeTimers();
    try {
      const store = new InMemoryEnvironmentDaemonSessionStore();
      const runtime = new EnvironmentDaemonRuntime({ threadId: "thread-1" });
      const sessionRuntime = new EnvironmentDaemonSessionRuntime({
        store,
        clock: () => 10_000,
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
          channels: [
            {
              channelId: "thread-1",
              applyFrom: { generation: 1, sequenceExclusive: 0 },
            },
          ],
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
          protocol: "bb.env-daemon.v1",
          type: "command_batch",
          messageId: "msg-cmd-empty",
          sessionId: "sess-1",
          sentAt: 3_500,
          payload: { commands: [] },
        });

      const sync = new EnvironmentDaemonSessionSync({ runtime: sessionRuntime, client });
      const supervisor = new EnvironmentDaemonSessionSupervisor({
        environmentId: "env-1",
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

  it("coalesces repeated runtime events before aborting an in-flight command pull", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(0);
      const store = new InMemoryEnvironmentDaemonSessionStore();
      const runtime = new EnvironmentDaemonRuntime({ threadId: "thread-1" });
      const sessionRuntime = new EnvironmentDaemonSessionRuntime({
        store,
        clock: () => 10_000,
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
          channels: [
            {
              channelId: "thread-1",
              applyFrom: { generation: 1, sequenceExclusive: 0 },
            },
          ],
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
              ackedThrough: { generation: 1, sequence: 2 },
            },
          ],
        },
      });
      let abortCount = 0;
      (client.pullCommands as ReturnType<typeof vi.fn>)
        .mockImplementationOnce(({ signal }: { signal: AbortSignal }) =>
          new Promise((_, reject) => {
            signal.addEventListener(
              "abort",
              () => {
                abortCount += 1;
                const error = new Error("Operation aborted");
                error.name = "AbortError";
                reject(error);
              },
              { once: true },
            );
          }))
        .mockResolvedValue({
          protocol: "bb.env-daemon.v1",
          type: "command_batch",
          messageId: "msg-cmd-empty",
          sessionId: "sess-1",
          sentAt: 3_500,
          payload: { commands: [] },
        });

      const sync = new EnvironmentDaemonSessionSync({ runtime: sessionRuntime, client });
      const supervisor = new EnvironmentDaemonSessionSupervisor({
        environmentId: "env-1",
        runtime,
        sessionRuntime,
        sessionSync: sync,
        pollIntervalMs: 5,
        eventFlushDebounceMs: 250,
      });

      const startPromise = supervisor.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(client.pullCommands).toHaveBeenCalledTimes(1);

      runtime.appendEvent({
        type: "provider.stderr",
        threadId: "thread-1",
        line: "stderr 1",
      });
      runtime.appendEvent({
        type: "provider.stderr",
        threadId: "thread-1",
        line: "stderr 2",
      });

      await vi.advanceTimersByTimeAsync(200);
      expect(abortCount).toBe(0);

      await vi.advanceTimersByTimeAsync(60);
      await startPromise;
      await vi.advanceTimersByTimeAsync(10);

      expect(abortCount).toBe(1);
      expect(client.pushEvents).toHaveBeenCalledTimes(1);
      expect(client.pushEvents).toHaveBeenCalledWith({
        sessionId: "sess-1",
        payload: {
          batches: [
            expect.objectContaining({
              channelId: "thread-1",
              events: [
                expect.objectContaining({
                  event: expect.objectContaining({
                    line: "stderr 1",
                  }),
                }),
                expect.objectContaining({
                  event: expect.objectContaining({
                    line: "stderr 2",
                  }),
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

  it("resends buffered events when the daemon acks an older cursor", async () => {
    const store = new InMemoryEnvironmentDaemonSessionStore();
    const runtime = new EnvironmentDaemonRuntime({ threadId: "thread-1" });
    const sessionRuntime = new EnvironmentDaemonSessionRuntime({
      store,
      clock: () => 10_000,
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
        channels: [
          {
            channelId: "thread-1",
            applyFrom: {
              generation: 1,
              sequenceExclusive: 1,
            },
          },
        ],
      },
    });
    (client.pushEvents as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        protocol: "bb.env-daemon.v1",
        type: "event_ack",
        messageId: "msg-reset",
        sessionId: "sess-1",
        sentAt: 3_000,
        payload: {
          channels: [
            {
              channelId: "thread-1",
              ackedThrough: { generation: 1, sequence: 0 },
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        protocol: "bb.env-daemon.v1",
        type: "event_ack",
        messageId: "msg-ack",
        sessionId: "sess-1",
        sentAt: 3_500,
        payload: {
          channels: [
            {
              channelId: "thread-1",
              ackedThrough: { generation: 1, sequence: 2 },
            },
          ],
        },
      });
    (client.pullCommands as ReturnType<typeof vi.fn>).mockResolvedValue({
      protocol: "bb.env-daemon.v1",
      type: "command_batch",
      messageId: "msg-cmd-empty",
      sessionId: "sess-1",
      sentAt: 4_000,
      payload: { commands: [] },
    });
    (client.closeSession as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

    const sync = new EnvironmentDaemonSessionSync({ runtime: sessionRuntime, client });
    const supervisor = new EnvironmentDaemonSessionSupervisor({
      environmentId: "env-1",
      runtime,
      sessionRuntime,
      sessionSync: sync,
      pollIntervalMs: 1_000,
    });

    sessionRuntime.initializeThread({
      threadId: "thread-1",
      agentId: "agent-shared",
      agentInstanceId: "instance-shared",
      generation: 1,
      now: 2_000,
    });
    sessionRuntime.recordEvent({
      threadId: "thread-1",
      eventId: "evt-1",
      event: {
        type: "environment.ready",
        threadId: "thread-1",
      },
      emittedAt: 2_100,
    });
    sessionRuntime.acknowledgeEvents({
      threadId: "thread-1",
      generation: 1,
      sequence: 1,
      ackedAt: 2_200,
    });
    sessionRuntime.recordEvent({
      threadId: "thread-1",
      eventId: "evt-2",
      event: {
        type: "provider.stderr",
        threadId: "thread-1",
        line: "stderr 1",
      },
      emittedAt: 2_300,
    });

    await supervisor.start();

    expect(client.pushEvents).toHaveBeenCalledTimes(2);
    expect((client.pushEvents as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toMatchObject({
      sessionId: "sess-1",
      payload: {
        batches: [
          {
            channelId: "thread-1",
            generation: 1,
            events: [expect.objectContaining({ eventId: "evt-2", sequence: 2 })],
          },
        ],
      },
    });
    expect((client.pushEvents as ReturnType<typeof vi.fn>).mock.calls[1]?.[0]).toMatchObject({
      sessionId: "sess-1",
      payload: {
        batches: [
          {
            channelId: "thread-1",
            generation: 1,
            events: [
              expect.objectContaining({ eventId: "evt-1", sequence: 1 }),
              expect.objectContaining({ eventId: "evt-2", sequence: 2 }),
            ],
          },
        ],
      },
    });
    expect(sessionRuntime.getPendingEventBatch({ threadId: "thread-1" })).toBeUndefined();

    await supervisor.close();
    await runtime.shutdown();
  });

  it("flushes buffered events and command results before closing the session", async () => {
    const store = new InMemoryEnvironmentDaemonSessionStore();
    const runtime = new EnvironmentDaemonRuntime({ threadId: "thread-1" });
    const sessionRuntime = new EnvironmentDaemonSessionRuntime({
      store,
      clock: () => 10_000,
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
      messageId: "msg-cmd-empty",
      sessionId: "sess-1",
      sentAt: 3_500,
      payload: { commands: [] },
    });
    (client.sendCommandResult as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    (client.closeSession as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

    const sync = new EnvironmentDaemonSessionSync({ runtime: sessionRuntime, client });
    const supervisor = new EnvironmentDaemonSessionSupervisor({
      environmentId: "env-1",
      runtime,
      sessionRuntime,
      sessionSync: sync,
      pollIntervalMs: 1_000,
    });

    await supervisor.start();

    sessionRuntime.recordEvent({
      threadId: "thread-1",
      eventId: "evt-1",
      event: {
        type: "provider.stderr",
        threadId: "thread-1",
        line: "stderr 1",
      },
      emittedAt: 4_000,
    });
    sessionRuntime.receiveCommand({
      commandId: "cmd-1",
      threadId: "thread-1",
      commandCursor: 1,
      commandType: "workspace.status",
      now: 4_100,
    });
    sessionRuntime.markCommandAckReported("cmd-1", 4_150);
    sessionRuntime.markCommandStarted("cmd-1", 4_200);
    sessionRuntime.markCommandCompleted({
      commandId: "cmd-1",
      result: { ok: true },
      now: 4_300,
    });

    await supervisor.close();
    await runtime.shutdown();

    expect(client.pushEvents).toHaveBeenCalledWith({
      sessionId: "sess-1",
      payload: {
        batches: [
          {
            channelId: "thread-1",
            generation: 1,
            events: [
              expect.objectContaining({
                eventId: "evt-1",
                event: {
                  type: "provider.stderr",
                  threadId: "thread-1",
                  line: "stderr 1",
                },
              }),
            ],
          },
        ],
      },
    });
    expect(client.sendCommandResult).toHaveBeenCalledWith(
      "sess-1",
      expect.objectContaining({
        commandId: "cmd-1",
        state: "completed",
        result: { ok: true },
      }),
    );
    expect(
      (client.closeSession as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0],
    ).toBeGreaterThan(
      (client.pushEvents as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0] ?? 0,
    );
    expect(
      (client.closeSession as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0],
    ).toBeGreaterThan(
      (client.sendCommandResult as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0] ?? 0,
    );
  });

});
