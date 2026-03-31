import { eq } from "drizzle-orm";
import { events, threads } from "@bb/db";
import { HOST_DAEMON_PROTOCOL_VERSION } from "@bb/host-daemon-contract";
import { describe, expect, it } from "vitest";
import { internalAuthHeaders } from "./helpers/commands.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
} from "./helpers/seed.js";
import { createTestAppHarness } from "./helpers/test-app.js";

async function readJson(response: Response): Promise<unknown> {
  return response.json();
}

describe("internal event and tool-call routes", () => {
  it("deduplicates events by thread and sequence and returns high-water marks", async () => {
    const harness = await createTestAppHarness();
    try {
      const firstCreatedAt = 1_700_000_000_000;
      const duplicateCreatedAt = firstCreatedAt + 50;
      const { host, session } = seedHostSession(harness.deps);
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
        headers: internalAuthHeaders(harness),
        body: JSON.stringify({
          sessionId: session.id,
          events: [
            {
              id: "evt-1",
              environmentId: environment.id,
              threadId: thread.id,
              sequence: 1,
              createdAt: firstCreatedAt,
              event: {
                type: "turn/started",
                threadId: thread.id,
                providerThreadId: "provider-1",
                turnId: "turn-1",
              },
            },
            {
              id: "evt-2",
              environmentId: environment.id,
              threadId: thread.id,
              sequence: 1,
              createdAt: duplicateCreatedAt,
              event: {
                type: "turn/started",
                threadId: thread.id,
                providerThreadId: "provider-1",
                turnId: "turn-1",
              },
            },
          ],
        }),
      });

      expect(response.status).toBe(200);
      await expect(readJson(response)).resolves.toEqual({
        threadHighWaterMarks: {
          [thread.id]: 1,
        },
      });
      const storedEvents = harness.db.select().from(events).all();
      expect(storedEvents).toHaveLength(1);
      expect(storedEvents[0]?.createdAt).toBe(firstCreatedAt);
    } finally {
      await harness.cleanup();
    }
  });

  it("transitions active threads back to idle for a started/completed event batch", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host, session } = seedHostSession(harness.deps);
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
        headers: internalAuthHeaders(harness),
        body: JSON.stringify({
          sessionId: session.id,
          events: [
            {
              id: "evt-started",
              environmentId: environment.id,
              threadId: thread.id,
              sequence: 1,
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
              environmentId: environment.id,
              threadId: thread.id,
              sequence: 2,
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
        }),
      });

      expect(response.status).toBe(200);
      expect(
        harness.db
          .select()
          .from(threads)
          .where(eq(threads.id, thread.id))
          .get()?.status,
      ).toBe("idle");
    } finally {
      await harness.cleanup();
    }
  });

  it("rejects unsupported tool calls", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host, session } = seedHostSession(harness.deps);
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
        headers: internalAuthHeaders(harness),
        body: JSON.stringify({
          sessionId: session.id,
          requestId: "req-1",
          threadId: managerThread.id,
          turnId: "turn-1",
          callId: "call-1",
          tool: "spawn_thread",
          arguments: {},
        }),
      });

      expect(response.status).toBe(200);
      await expect(readJson(response)).resolves.toMatchObject({
        success: false,
        contentItems: [{ type: "inputText", text: "Unsupported tool: spawn_thread" }],
      });

      const childThreads = harness.db
        .select()
        .from(threads)
        .where(eq(threads.parentThreadId, managerThread.id))
        .all();
      expect(childThreads).toHaveLength(0);
    } finally {
      await harness.cleanup();
    }
  });

  it("accepts message_user tool calls and appends a manager message event", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host, session } = seedHostSession(harness.deps);
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
        headers: internalAuthHeaders(harness),
        body: JSON.stringify({
          sessionId: session.id,
          requestId: "req-2",
          threadId: managerThread.id,
          turnId: "turn-2",
          callId: "call-2",
          tool: "message_user",
          arguments: {
            text: "Need input from the user",
          },
        }),
      });

      expect(response.status).toBe(200);
      const storedEvents = harness.db.select().from(events).all();
      expect(storedEvents).toHaveLength(1);
      expect(storedEvents[0]?.type).toBe("system/manager/user_message");
    } finally {
      await harness.cleanup();
    }
  });
});
