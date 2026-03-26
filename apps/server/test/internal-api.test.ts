import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { events, hostDaemonCommands, threads } from "@bb/db";
import { createTestAppHarness } from "./helpers/test-app.js";
import {
  seedEnvironment,
  seedHost,
  seedProjectWithSource,
  seedSession,
  seedThread,
} from "./helpers/seed.js";
import { appendClientTurnEvent } from "../src/services/thread-events.js";

async function readJson(response: Response): Promise<unknown> {
  return response.json();
}

describe("internal API routes", () => {
  it("opens a session and returns host thread high-water marks", async () => {
    const harness = await createTestAppHarness();
    try {
      const response = await harness.app.request("/internal/session/open", {
        method: "POST",
        headers: {
          authorization: `Bearer ${harness.config.authToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          hostId: "host-1",
          instanceId: "instance-1",
          hostName: "Test Host",
          hostType: "persistent",
          protocolVersion: 2,
        }),
      });

      expect(response.status).toBe(201);
      const body = await readJson(response) as { sessionId: string };
      expect(body.sessionId).toBeTruthy();
    } finally {
      await harness.cleanup();
    }
  });

  it("marks provisioned environments ready and queues thread.start for pending input", async () => {
    const harness = await createTestAppHarness();
    try {
      const host = seedHost(harness.deps, { id: "host-1" });
      const session = seedSession(harness.deps, host.id);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/project-root",
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/project-root",
        status: "provisioning",
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "provisioning",
      });
      appendClientTurnEvent(harness.deps, thread.id, environment.id, "client/thread/start", {
        input: [{ type: "text", text: "Ship it" }],
        execution: { source: "client/thread/start" },
        initiator: "user",
        requestMethod: "thread/start",
        source: "spawn",
      });
      const provisionCommand = harness.db
        .insert(hostDaemonCommands)
        .values({
          id: "cmd-1",
          hostId: host.id,
          sessionId: session.id,
          cursor: 1,
          type: "environment.provision",
          payload: JSON.stringify({
            type: "environment.provision",
            environmentId: environment.id,
            projectId: project.id,
            workspaceProvisionType: "unmanaged",
            path: "/tmp/project-root",
          }),
          state: "fetched",
          retryCount: 0,
          createdAt: Date.now(),
          fetchedAt: Date.now(),
        })
        .run();
      void provisionCommand;

      const response = await harness.app.request("/internal/session/command-result", {
        method: "POST",
        headers: {
          authorization: `Bearer ${harness.config.authToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          sessionId: session.id,
          commandId: "cmd-1",
          cursor: 1,
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
        }),
      });

      expect(response.status).toBe(200);
      const updatedEnvironment = harness.db
        .select()
        .from((await import("@bb/db")).environments)
        .where(eq((await import("@bb/db")).environments.id, environment.id))
        .get();
      const updatedThread = harness.db
        .select()
        .from(threads)
        .where(eq(threads.id, thread.id))
        .get();
      const commands = harness.db.select().from(hostDaemonCommands).all();

      expect(updatedEnvironment?.status).toBe("ready");
      expect(updatedThread?.status).toBe("active");
      expect(commands.at(-1)?.type).toBe("thread.start");
    } finally {
      await harness.cleanup();
    }
  });

  it("ingests events and transitions turn/completed threads back to idle", async () => {
    const harness = await createTestAppHarness();
    try {
      const host = seedHost(harness.deps, { id: "host-1" });
      const session = seedSession(harness.deps, host.id);
      const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "active",
      });

      const response = await harness.app.request("/internal/session/events", {
        method: "POST",
        headers: {
          authorization: `Bearer ${harness.config.authToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          sessionId: session.id,
          events: [
            {
              id: "evt-1",
              environmentId: environment.id,
              threadId: thread.id,
              sequence: 1,
              createdAt: Date.now(),
              event: {
                type: "turn/completed",
                threadId: thread.id,
                providerThreadId: "provider-thread-1",
                turnId: "turn-1",
                status: "completed",
              },
            },
          ],
        }),
      });

      expect(response.status).toBe(200);
      const storedEvents = harness.db.select().from(events).all();
      const updatedThread = harness.db
        .select()
        .from(threads)
        .where(eq(threads.id, thread.id))
        .get();
      expect(storedEvents).toHaveLength(1);
      expect(updatedThread?.status).toBe("idle");
    } finally {
      await harness.cleanup();
    }
  });

  it("creates child threads through the spawn_thread tool call", async () => {
    const harness = await createTestAppHarness();
    try {
      const host = seedHost(harness.deps, { id: "host-1" });
      const session = seedSession(harness.deps, host.id);
      const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
      });
      const managerThread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        type: "manager",
      });

      const response = await harness.app.request("/internal/session/tool-call", {
        method: "POST",
        headers: {
          authorization: `Bearer ${harness.config.authToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          sessionId: session.id,
          requestId: "req-1",
          threadId: managerThread.id,
          turnId: "turn-1",
          callId: "call-1",
          tool: "spawn_thread",
          arguments: {
            title: "Worker thread",
            prompt: "Implement the endpoint",
          },
        }),
      });

      expect(response.status).toBe(200);
      const childThreads = harness.db
        .select()
        .from(threads)
        .where(eq(threads.parentThreadId, managerThread.id))
        .all();
      expect(childThreads).toHaveLength(1);
      expect(childThreads[0]?.title).toBe("Worker thread");
    } finally {
      await harness.cleanup();
    }
  });
});
