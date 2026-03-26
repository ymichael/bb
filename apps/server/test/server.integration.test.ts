import { describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import type { RawData } from "ws";
import { createHostDaemonClient } from "@bb/host-daemon-contract";
import { createPublicApiClient } from "@bb/server-contract";
import { startTestServer } from "./helpers/test-app.js";

function waitForOpen(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
  });
}

function waitForMessage(socket: WebSocket): Promise<unknown> {
  return new Promise((resolve, reject) => {
    socket.once("message", (data) => {
      resolve(JSON.parse(data.toString("utf8")));
    });
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

describe("server integration", () => {
  it("runs the session -> thread creation -> command fetch -> command result loop with typed clients", async () => {
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
      expect(projectResponse.status).toBe(201);
      const project = await projectResponse.json();

      const threadResponse = await publicClient.threads.$post({
        json: {
          projectId: project.id,
          providerId: "codex",
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

      const ws = new WebSocket(`${server.baseUrl.replace("http", "ws")}/ws`);
      await waitForOpen(ws);
      ws.send(JSON.stringify({ type: "subscribe", entity: "thread", id: thread.id }));
      await new Promise((resolve) => setTimeout(resolve, 25));

      const commandBatchResponse = await daemonClient.session.commands.$get({
        query: { sessionId: session.sessionId, afterCursor: "0" },
      });
      expect(commandBatchResponse.status).toBe(200);
      const commandBatch = await commandBatchResponse.json();
      expect(commandBatch.commands).toHaveLength(1);

      const changedMessagePromise = waitForMatchingMessage<{
        entity: string;
        changes: string[];
        id?: string;
      }>(
        ws,
        (message): message is { entity: string; changes: string[]; id?: string } =>
          message != null &&
          typeof message === "object" &&
          "entity" in message &&
          "changes" in message &&
          message.entity === "thread" &&
          message.id === thread.id &&
          Array.isArray(message.changes) &&
          message.changes.includes("status-changed"),
      );
      const reportResponse = await daemonClient.session["command-result"].$post({
        json: {
          sessionId: session.sessionId,
          commandId: commandBatch.commands[0].id,
          cursor: commandBatch.commands[0].cursor,
          completedAt: Date.now(),
          type: "environment.provision",
          ok: true,
          result: {
            path: "/tmp/project-root",
            branchName: "bb/test",
            isGitRepo: true,
            isWorktree: false,
            ranSetup: false,
          },
        },
      });
      expect(reportResponse.status).toBe(200);

      const changedMessage = await changedMessagePromise;
      expect(changedMessage.entity).toBe("thread");
      expect(changedMessage.id).toBe(thread.id);
      expect(changedMessage.changes).toContain("status-changed");

      ws.close();
    } finally {
      await server.close();
    }
  });

  it("notifies replaced daemon websocket sessions with session-close", async () => {
    const server = await startTestServer();
    try {
      const daemonClient = createHostDaemonClient(server.baseUrl, server.config.authToken);

      const firstSessionResponse = await daemonClient.session.open.$post({
        json: {
          hostId: "host-1",
          instanceId: "instance-1",
          hostName: "Test Host",
          hostType: "persistent",
          protocolVersion: 2,
        },
      });
      const firstSession = await firstSessionResponse.json();

      const daemonWs = new WebSocket(
        `${server.baseUrl.replace("http", "ws")}/internal/ws?sessionId=${encodeURIComponent(firstSession.sessionId)}&token=${encodeURIComponent(server.config.authToken)}`,
      );
      await waitForOpen(daemonWs);

      const sessionClosePromise = waitForMessage(daemonWs);
      const secondSessionResponse = await daemonClient.session.open.$post({
        json: {
          hostId: "host-1",
          instanceId: "instance-2",
          hostName: "Test Host",
          hostType: "persistent",
          protocolVersion: 2,
        },
      });
      expect(secondSessionResponse.status).toBe(201);

      const sessionCloseMessage = await sessionClosePromise as { type: string; reason: string };
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
