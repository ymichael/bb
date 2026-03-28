import type { RawData } from "ws";
import { WebSocket } from "ws";
import {
  createHostDaemonClient,
  type HostDaemonCommandEnvelope,
} from "@bb/host-daemon-contract";
import { createPublicApiClient } from "@bb/server-contract";
import { describe, expect, it } from "vitest";
import { startTestServer } from "./helpers/test-app.js";

function waitForOpen(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
  });
}

function waitForMatchingMessage<T>(
  socket: WebSocket,
  matches: (message: unknown) => message is T,
  timeoutMs = 3_000,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.off("message", onMessage);
      socket.off("error", onError);
      reject(new Error("Timed out waiting for websocket message"));
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timeout);
      socket.off("message", onMessage);
      socket.off("error", onError);
    };

    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };

    const onMessage = (data: RawData) => {
      const message = JSON.parse(data.toString("utf8")) as unknown;
      if (!matches(message)) {
        return;
      }
      cleanup();
      resolve(message);
    };

    socket.on("message", onMessage);
    socket.on("error", onError);
  });
}

async function waitForThreadSubscription(
  hub: { notifyThread(threadId: string, changes: string[]): void },
  socket: WebSocket,
  threadId: string,
): Promise<void> {
  const readyMessage = waitForMatchingMessage<{
    changes: string[];
    entity: string;
    id?: string;
  }>(
    socket,
    (message): message is { changes: string[]; entity: string; id?: string } =>
      message != null &&
      typeof message === "object" &&
      "entity" in message &&
      "changes" in message &&
      message.entity === "thread" &&
      message.id === threadId &&
      Array.isArray(message.changes) &&
      message.changes.includes("status-changed"),
    2_000,
  );
  const interval = setInterval(() => {
    hub.notifyThread(threadId, ["status-changed"]);
  }, 25);

  try {
    hub.notifyThread(threadId, ["status-changed"]);
    await readyMessage;
  } finally {
    clearInterval(interval);
  }
}

async function fetchSingleCommand(
  daemonClient: ReturnType<typeof createHostDaemonClient>,
  sessionId: string,
  afterCursor: number,
): Promise<HostDaemonCommandEnvelope> {
  const response = await daemonClient.session.commands.$get({
    query: {
      sessionId,
      afterCursor: String(afterCursor),
      limit: "100",
      waitMs: "0",
    },
  });
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.commands).toHaveLength(1);
  return body.commands[0];
}

async function getNextEventSequence(
  publicClient: ReturnType<typeof createPublicApiClient>,
  threadId: string,
): Promise<number> {
  const response = await publicClient.threads[":id"].events.$get({
    param: { id: threadId },
  });
  expect(response.status).toBe(200);
  const events = await response.json();
  const lastSequence = events.at(-1)?.seq ?? 0;
  return lastSequence + 1;
}

describe("server integration", () => {
  it("runs session open -> thread creation -> command fetch -> result report -> state update", async () => {
    const server = await startTestServer();
    try {
      const daemonClient = createHostDaemonClient(server.baseUrl, server.config.authToken);
      const publicClient = createPublicApiClient(server.baseUrl);

      const sessionResponse = await daemonClient.session.open.$post({
        json: {
          hostId: "host-1",
          instanceId: "instance-1",
          hostName: "Test Host",
          hostType: "persistent",
          protocolVersion: 2,
          activeThreads: [],
        },
      });
      expect(sessionResponse.status).toBe(201);
      const session = await sessionResponse.json();

      const projectResponse = await publicClient.projects.$post({
        json: {
          name: "Test Project",
          hostId: "host-1",
          sourcePath: "/tmp/project-root",
        },
      });
      const project = await projectResponse.json();

      const threadResponse = await publicClient.threads.$post({
        json: {
          projectId: project.id,
          providerId: "codex",
          type: "standard",
          model: "gpt-5",
          input: [{ type: "text", text: "Build the feature" }],
          environment: {
            type: "host",
            hostId: "host-1",
            workspace: { type: "unmanaged", path: null },
          },
        },
      });
      expect(threadResponse.status).toBe(201);
      const thread = await threadResponse.json();

      const provisionCommand = await fetchSingleCommand(
        daemonClient,
        session.sessionId,
        0,
      );
      expect(provisionCommand.command.type).toBe("environment.provision");

      const resultResponse = await daemonClient.session["command-result"].$post({
        json: {
          sessionId: session.sessionId,
          commandId: provisionCommand.id,
          cursor: provisionCommand.cursor,
          completedAt: Date.now(),
          type: "environment.provision",
          ok: true,
          result: {
            path: "/tmp/project-root",
            branchName: "bb/test",
            defaultBranch: "main",
            isGitRepo: true,
            isWorktree: false,
            ranSetup: false,
          },
        },
      });
      expect(resultResponse.status).toBe(200);

      const threadGetResponse = await publicClient.threads[":id"].$get({
        param: { id: thread.id },
      });
      const updatedThread = await threadGetResponse.json();
      expect(updatedThread.status).toBe("active");

      const environmentGetResponse = await publicClient.environments[":id"].$get({
        param: { id: thread.environmentId },
      });
      const environment = await environmentGetResponse.json();
      expect(environment.status).toBe("ready");
    } finally {
      await server.close();
    }
  });

  it("sends events-appended websocket notifications for thread event ingestion", async () => {
    const server = await startTestServer();
    try {
      const daemonClient = createHostDaemonClient(server.baseUrl, server.config.authToken);
      const publicClient = createPublicApiClient(server.baseUrl);

      const session = await (
        await daemonClient.session.open.$post({
          json: {
            hostId: "host-1",
            instanceId: "instance-1",
            hostName: "Test Host",
            hostType: "persistent",
            protocolVersion: 2,
            activeThreads: [],
          },
        })
      ).json();
      const project = await (
        await publicClient.projects.$post({
          json: {
            name: "Event Project",
            hostId: "host-1",
            sourcePath: "/tmp/event-project",
          },
        })
      ).json();
      const thread = await (
        await publicClient.threads.$post({
          json: {
            projectId: project.id,
            providerId: "codex",
            type: "standard",
            model: "gpt-5",
            input: [{ type: "text", text: "Start the event thread" }],
            environment: {
              type: "host",
              hostId: "host-1",
              workspace: { type: "unmanaged", path: null },
            },
          },
        })
      ).json();
      const provisionCommand = await fetchSingleCommand(
        daemonClient,
        session.sessionId,
        0,
      );
      await daemonClient.session["command-result"].$post({
        json: {
          sessionId: session.sessionId,
          commandId: provisionCommand.id,
          cursor: provisionCommand.cursor,
          completedAt: Date.now(),
          type: "environment.provision",
          ok: true,
          result: {
            path: "/tmp/event-project",
            branchName: "bb/event",
            defaultBranch: "main",
            isGitRepo: true,
            isWorktree: false,
            ranSetup: false,
          },
        },
      });
      const threadStartCommand = await fetchSingleCommand(
        daemonClient,
        session.sessionId,
        provisionCommand.cursor,
      );
      expect(threadStartCommand.command.type).toBe("thread.start");
      await daemonClient.session["command-result"].$post({
        json: {
          sessionId: session.sessionId,
          commandId: threadStartCommand.id,
          cursor: threadStartCommand.cursor,
          completedAt: Date.now(),
          type: "thread.start",
          ok: true,
          result: {
            providerThreadId: "provider-thread",
          },
        },
      });

      const ws = new WebSocket(`${server.baseUrl.replace("http", "ws")}/ws`);
      await waitForOpen(ws);
      ws.send(JSON.stringify({ type: "subscribe", entity: "thread", id: thread.id }));
      await waitForThreadSubscription(server.hub, ws, thread.id);

      const messagePromise = waitForMatchingMessage<{
        changes: string[];
        entity: string;
        id?: string;
      }>(
        ws,
        (message): message is { changes: string[]; entity: string; id?: string } =>
          message != null &&
          typeof message === "object" &&
          "entity" in message &&
          "changes" in message &&
          message.entity === "thread" &&
          message.id === thread.id &&
          Array.isArray(message.changes) &&
          message.changes.includes("events-appended"),
      );
      const nextSequence = await getNextEventSequence(publicClient, thread.id);

      const eventResponse = await daemonClient.session.events.$post({
        json: {
          sessionId: session.sessionId,
          events: [
            {
              id: "evt-1",
              environmentId: thread.environmentId,
              threadId: thread.id,
              sequence: nextSequence,
              createdAt: Date.now(),
              event: {
                type: "turn/started",
                threadId: thread.id,
                providerThreadId: "provider-thread",
                turnId: "turn-1",
              },
            },
          ],
        },
      });
      expect(eventResponse.status).toBe(200);

      const message = await messagePromise;
      expect(message.changes).toContain("events-appended");
      ws.close();
    } finally {
      await server.close();
    }
  });

  it("runs a full create -> send -> result -> events -> idle lifecycle", async () => {
    const server = await startTestServer();
    try {
      const daemonClient = createHostDaemonClient(server.baseUrl, server.config.authToken);
      const publicClient = createPublicApiClient(server.baseUrl);

      const session = await (
        await daemonClient.session.open.$post({
          json: {
            hostId: "host-1",
            instanceId: "instance-1",
            hostName: "Lifecycle Host",
            hostType: "persistent",
            protocolVersion: 2,
            activeThreads: [],
          },
        })
      ).json();
      const project = await (
        await publicClient.projects.$post({
          json: {
            name: "Lifecycle Project",
            hostId: "host-1",
            sourcePath: "/tmp/lifecycle-project",
          },
        })
      ).json();
      const thread = await (
        await publicClient.threads.$post({
          json: {
            projectId: project.id,
            providerId: "codex",
            type: "standard",
            model: "gpt-5",
            input: [{ type: "text", text: "Start the lifecycle thread" }],
            environment: {
              type: "host",
              hostId: "host-1",
              workspace: { type: "unmanaged", path: null },
            },
          },
        })
      ).json();

      const provisionCommand = await fetchSingleCommand(
        daemonClient,
        session.sessionId,
        0,
      );
      await daemonClient.session["command-result"].$post({
        json: {
          sessionId: session.sessionId,
          commandId: provisionCommand.id,
          cursor: provisionCommand.cursor,
          completedAt: Date.now(),
          type: "environment.provision",
          ok: true,
          result: {
            path: "/tmp/lifecycle-project",
            branchName: "bb/lifecycle",
            defaultBranch: "main",
            isGitRepo: true,
            isWorktree: false,
            ranSetup: false,
          },
        },
      });

      const initialThreadStartCommand = await fetchSingleCommand(
        daemonClient,
        session.sessionId,
        provisionCommand.cursor,
      );
      expect(initialThreadStartCommand.command.type).toBe("thread.start");

      await daemonClient.session["command-result"].$post({
        json: {
          sessionId: session.sessionId,
          commandId: initialThreadStartCommand.id,
          cursor: initialThreadStartCommand.cursor,
          completedAt: Date.now(),
          type: "thread.start",
          ok: true,
          result: {
            providerThreadId: "provider-thread",
          },
        },
      });

      const initialNextSequence = await getNextEventSequence(publicClient, thread.id);
      const initialEventsResponse = await daemonClient.session.events.$post({
        json: {
          sessionId: session.sessionId,
          events: [
            {
              id: "evt-initial-started",
              environmentId: thread.environmentId,
              threadId: thread.id,
              sequence: initialNextSequence,
              createdAt: Date.now(),
              event: {
                type: "turn/started",
                threadId: thread.id,
                providerThreadId: "provider-thread",
                turnId: "turn-initial",
              },
            },
            {
              id: "evt-initial-completed",
              environmentId: thread.environmentId,
              threadId: thread.id,
              sequence: initialNextSequence + 1,
              createdAt: Date.now(),
              event: {
                type: "turn/completed",
                threadId: thread.id,
                providerThreadId: "provider-thread",
                turnId: "turn-initial",
                status: "completed",
              },
            },
          ],
        },
      });
      expect(initialEventsResponse.status).toBe(200);

      const afterInitialTurnThread = await (
        await publicClient.threads[":id"].$get({ param: { id: thread.id } })
      ).json();
      expect(afterInitialTurnThread.status).toBe("idle");

      const sendResponse = await publicClient.threads[":id"].send.$post({
        param: { id: thread.id },
        json: {
          input: [{ type: "text", text: "Continue the task" }],
          mode: "auto",
        },
      });
      expect(sendResponse.status).toBe(200);

      const turnRunCommand = await fetchSingleCommand(
        daemonClient,
        session.sessionId,
        initialThreadStartCommand.cursor,
      );
      expect(turnRunCommand.command.type).toBe("turn.run");

      await daemonClient.session["command-result"].$post({
        json: {
          sessionId: session.sessionId,
          commandId: turnRunCommand.id,
          cursor: turnRunCommand.cursor,
          completedAt: Date.now(),
          type: "turn.run",
          ok: true,
          result: {},
        },
      });

      const nextSequence = await getNextEventSequence(publicClient, thread.id);
      const eventsResponse = await daemonClient.session.events.$post({
        json: {
          sessionId: session.sessionId,
          events: [
            {
              id: "evt-started",
              environmentId: thread.environmentId,
              threadId: thread.id,
              sequence: nextSequence,
              createdAt: Date.now(),
              event: {
                type: "turn/started",
                threadId: thread.id,
                providerThreadId: "provider-thread",
                turnId: "turn-1",
              },
            },
            {
              id: "evt-completed",
              environmentId: thread.environmentId,
              threadId: thread.id,
              sequence: nextSequence + 1,
              createdAt: Date.now(),
              event: {
                type: "turn/completed",
                threadId: thread.id,
                providerThreadId: "provider-thread",
                turnId: "turn-1",
                status: "completed",
              },
            },
          ],
        },
      });
      expect(eventsResponse.status).toBe(200);

      const finalThread = await (
        await publicClient.threads[":id"].$get({ param: { id: thread.id } })
      ).json();
      expect(finalThread.status).toBe("idle");
    } finally {
      await server.close();
    }
  });

  it("notifies replaced daemon websocket sessions with session-close", async () => {
    const server = await startTestServer();
    try {
      const daemonClient = createHostDaemonClient(server.baseUrl, server.config.authToken);

      const firstSession = await (
        await daemonClient.session.open.$post({
          json: {
            hostId: "host-1",
            instanceId: "instance-1",
            hostName: "Test Host",
            hostType: "persistent",
            protocolVersion: 2,
            activeThreads: [],
          },
        })
      ).json();

      const daemonWs = new WebSocket(
        `${server.baseUrl.replace("http", "ws")}/internal/ws?sessionId=${encodeURIComponent(firstSession.sessionId)}&token=${encodeURIComponent(server.config.authToken)}`,
      );
      await waitForOpen(daemonWs);

      const sessionClosePromise = waitForMatchingMessage<{
        reason: string;
        type: string;
      }>(
        daemonWs,
        (message): message is { reason: string; type: string } =>
          message != null &&
          typeof message === "object" &&
          "type" in message &&
          "reason" in message &&
          message.type === "session-close",
      );

      const secondSessionResponse = await daemonClient.session.open.$post({
        json: {
          hostId: "host-1",
          instanceId: "instance-2",
          hostName: "Test Host",
          hostType: "persistent",
          protocolVersion: 2,
          activeThreads: [],
        },
      });
      expect(secondSessionResponse.status).toBe(201);

      const sessionCloseMessage = await sessionClosePromise;
      expect(sessionCloseMessage).toEqual({
        type: "session-close",
        reason: "replaced",
      });

      daemonWs.close();
    } finally {
      await server.close();
    }
  });
});
