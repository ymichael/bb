import { eq } from "drizzle-orm";
import { getDraft, threads } from "@bb/db";
import { describe, expect, it, vi } from "vitest";
import {
  internalAuthHeaders,
  waitForQueuedCommand,
} from "./helpers/commands.js";
import {
  seedDraft,
  seedEnvironment,
  seedEvent,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
} from "./helpers/seed.js";
import { createTestAppHarness } from "./helpers/test-app.js";

describe("internal event side effects", () => {
  it("logs side-effect failures and continues processing the rest of the batch", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-event-resilience",
      });
      const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
      });
      const renamedThread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
      });
      const startedThread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "idle",
      });

      const originalNotifyThread = harness.hub.notifyThread.bind(harness.hub);
      harness.hub.notifyThread = (threadId, changes) => {
        if (threadId === renamedThread.id && changes.includes("title-changed")) {
          throw new Error("title notification failed");
        }
        originalNotifyThread(threadId, changes);
      };
      const loggerError = vi.fn();
      harness.deps.logger.error = loggerError;

      const response = await harness.app.request("/internal/session/events", {
        method: "POST",
        headers: internalAuthHeaders(harness),
        body: JSON.stringify({
          sessionId: session.id,
          events: [
            {
              id: "evt-name-updated",
              environmentId: environment.id,
              threadId: renamedThread.id,
              sequence: 1,
              createdAt: Date.now(),
              event: {
                type: "thread/name/updated",
                threadId: renamedThread.id,
                providerThreadId: "provider-resilience",
                threadName: "Renamed thread",
              },
            },
            {
              id: "evt-turn-started",
              environmentId: environment.id,
              threadId: startedThread.id,
              sequence: 1,
              createdAt: Date.now(),
              event: {
                type: "turn/started",
                threadId: startedThread.id,
                providerThreadId: "provider-resilience",
                turnId: "turn-resilience",
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
          .where(eq(threads.id, startedThread.id))
          .get()?.status,
      ).toBe("active");
      expect(loggerError).toHaveBeenCalledTimes(1);
    } finally {
      await harness.cleanup();
    }
  });

  it("auto-sends the next queued draft when a turn completes", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-event-auto-send",
      });
      const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/queued-draft-auto-send",
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "active",
      });
      seedEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        providerThreadId: "provider-auto-send",
        sequence: 1,
        type: "thread/identity",
        data: {},
      });
      seedEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        providerThreadId: "provider-auto-send",
        sequence: 2,
        turnId: "turn-auto-send",
        type: "turn/started",
        data: {},
      });
      const draft = seedDraft(harness.deps, {
        threadId: thread.id,
        content: JSON.stringify([{ type: "text", text: "Queued follow-up" }]),
        model: "gpt-5",
        serviceTier: "flex",
      });

      const response = await harness.app.request("/internal/session/events", {
        method: "POST",
        headers: internalAuthHeaders(harness),
        body: JSON.stringify({
          sessionId: session.id,
          events: [
            {
              id: "evt-turn-completed",
              environmentId: environment.id,
              threadId: thread.id,
              sequence: 3,
              createdAt: Date.now(),
              event: {
                type: "turn/completed",
                threadId: thread.id,
                providerThreadId: "provider-auto-send",
                turnId: "turn-auto-send",
                status: "completed",
              },
            },
          ],
        }),
      });

      expect(response.status).toBe(200);
      const queuedCommand = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "turn.run" && command.threadId === thread.id,
      );
      expect(queuedCommand.command).toMatchObject({
        providerThreadId: "provider-auto-send",
        input: [{ type: "text", text: "Queued follow-up" }],
        options: {
          model: "gpt-5",
          serviceTier: "flex",
        },
      });
      expect(getDraft(harness.db, draft.id)).toBeNull();
      expect(
        harness.db
          .select()
          .from(threads)
          .where(eq(threads.id, thread.id))
          .get()?.status,
      ).toBe("active");
    } finally {
      await harness.cleanup();
    }
  });
});
