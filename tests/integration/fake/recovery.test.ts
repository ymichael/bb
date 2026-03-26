// Phase 7d: Fake provider recovery scenarios (plans/rebuild.md)
import { and, desc, eq, isNotNull } from "drizzle-orm";
import {
  events,
  hostDaemonSessions,
  queueCommand,
  transitionThreadStatus,
} from "@bb/db";
import { readCommandCursor } from "@bb/host-daemon/test";
import { hostDaemonCommandSchema } from "@bb/host-daemon-contract";
import { describe, expect, it } from "vitest";
import {
  getThread,
  getThreadEvents,
  getThreadOutput,
  sendTextMessage,
} from "../helpers/api.js";
import {
  waitForEventType,
  waitForEvents,
  waitForHostConnected,
  waitForHostDisconnected,
  waitForThreadStatus,
} from "../helpers/assertions.js";
import {
  createProjectFixture,
  createReadyHostThread,
} from "../helpers/fixtures.js";
import {
  createIntegrationHarness,
  type IntegrationHarness,
} from "../helpers/harness.js";
import { scaleTimeoutMs } from "../helpers/time.js";

// Setup waits: create the thread and observe the first ready/idle state.
const DEFAULT_TIMEOUT_MS = scaleTimeoutMs(10_000);
// Whole-turn waits: standard provider turns should settle within this budget.
const TURN_TIMEOUT_MS = scaleTimeoutMs(15_000);
// Recovery waits: allow for disconnect detection plus daemon restart and reconciliation.
const RECOVERY_TIMEOUT_MS = scaleTimeoutMs(30_000);
// Active-turn waits: only long enough to catch a turn in flight before the crash/restart step.
const ACTIVE_TIMEOUT_MS = scaleTimeoutMs(5_000);
const STOP_DELAY_TEXT = "delay:5000 recovery turn";

function assertMonotonicSequences(
  events: Awaited<ReturnType<typeof getThreadEvents>>,
): void {
  for (let index = 1; index < events.length; index += 1) {
    expect(events[index]?.seq).toBeGreaterThan(events[index - 1]?.seq ?? -1);
  }
}

function getSession(
  harness: IntegrationHarness,
  sessionId: string,
): typeof hostDaemonSessions.$inferSelect | null {
  return (
    harness.db
      .select()
      .from(hostDaemonSessions)
      .where(eq(hostDaemonSessions.id, sessionId))
      .get() ?? null
  );
}

function requireSessionId(harness: IntegrationHarness): string {
  const sessionId = harness.daemonApp.connection.sessionId;
  if (!sessionId) {
    throw new Error("Daemon session is not open");
  }
  return sessionId;
}

async function createRecoveryThread(
  harness: IntegrationHarness,
  name: string,
) {
  const project = await createProjectFixture(harness, { name });
  return createReadyHostThread(harness, {
    projectId: project.id,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    workspace: {
      type: "unmanaged",
      path: harness.repoDir,
    },
  });
}

describe.sequential("fake provider recovery integration", () => {
  it("restarts cleanly after a graceful shutdown and continues an existing thread", async () => {
    const harness = await createIntegrationHarness();

    try {
      const { thread } = await createRecoveryThread(
        harness,
        "Graceful Shutdown Recovery",
      );
      const oldSessionId = requireSessionId(harness);

      await sendTextMessage(harness.api, thread.id, {
        text: "before graceful restart",
      });
      await waitForThreadStatus(harness.api, thread.id, "idle", TURN_TIMEOUT_MS);

      await harness.shutdownDaemon("graceful-restart");
      await waitForHostDisconnected(
        harness.api,
        harness.hostId,
        RECOVERY_TIMEOUT_MS,
      );

      await harness.startDaemon();
      await waitForHostConnected(harness.api, RECOVERY_TIMEOUT_MS);
      const newSessionId = requireSessionId(harness);
      expect(newSessionId).not.toBe(oldSessionId);

      await sendTextMessage(harness.api, thread.id, {
        text: "after graceful restart",
      });
      await waitForThreadStatus(harness.api, thread.id, "idle", TURN_TIMEOUT_MS);

      expect(await getThreadOutput(harness.api, thread.id)).toContain(
        "after graceful restart",
      );
    } finally {
      await harness.cleanup();
    }
  });

  it("survives an ungraceful daemon crash and resumes idle work after restart", async () => {
    const harness = await createIntegrationHarness();

    try {
      const { thread } = await createRecoveryThread(
        harness,
        "Crash Recovery Idle",
      );

      await sendTextMessage(harness.api, thread.id, {
        text: "before crash restart",
      });
      await waitForThreadStatus(harness.api, thread.id, "idle", TURN_TIMEOUT_MS);

      await harness.crashDaemon();
      await waitForHostDisconnected(
        harness.api,
        harness.hostId,
        RECOVERY_TIMEOUT_MS,
      );

      await harness.startDaemon();
      await waitForHostConnected(harness.api, RECOVERY_TIMEOUT_MS);

      await sendTextMessage(harness.api, thread.id, {
        text: "after crash restart",
      });
      await waitForThreadStatus(harness.api, thread.id, "idle", TURN_TIMEOUT_MS);

      expect(await getThreadOutput(harness.api, thread.id)).toContain(
        "after crash restart",
      );
    } finally {
      await harness.cleanup();
    }
  });

  it("moves an active thread to error on crash and allows a new turn after restart", async () => {
    const harness = await createIntegrationHarness();

    try {
      const { thread } = await createRecoveryThread(
        harness,
        "Crash Recovery Active",
      );

      await sendTextMessage(harness.api, thread.id, {
        text: STOP_DELAY_TEXT,
      });
      await waitForThreadStatus(
        harness.api,
        thread.id,
        "active",
        ACTIVE_TIMEOUT_MS,
      );

      await harness.crashDaemon();
      await waitForHostDisconnected(
        harness.api,
        harness.hostId,
        RECOVERY_TIMEOUT_MS,
      );
      await waitForThreadStatus(
        harness.api,
        thread.id,
        "error",
        RECOVERY_TIMEOUT_MS,
      );

      await harness.startDaemon();
      await waitForHostConnected(harness.api, RECOVERY_TIMEOUT_MS);

      await sendTextMessage(harness.api, thread.id, {
        text: "recovered after crash",
      });
      await waitForThreadStatus(harness.api, thread.id, "idle", TURN_TIMEOUT_MS);

      const events = await getThreadEvents(harness.api, thread.id);
      expect(
        events.some(
          (event) =>
            event.type === "system/error" &&
            event.data.code === "host_daemon_disconnected",
        ),
      ).toBe(true);
      expect(await getThreadOutput(harness.api, thread.id)).toContain(
        "recovered after crash",
      );
    } finally {
      await harness.cleanup();
    }
  });

  it("preserves cursor continuity and event sequencing across restart", async () => {
    const harness = await createIntegrationHarness();

    try {
      const { thread } = await createRecoveryThread(
        harness,
        "Cursor Continuity",
      );

      await sendTextMessage(harness.api, thread.id, {
        text: "cursor first turn",
      });
      await waitForThreadStatus(harness.api, thread.id, "idle", TURN_TIMEOUT_MS);

      const cursorBefore = await readCommandCursor(harness.daemonDataDir);
      const eventsBefore = await getThreadEvents(harness.api, thread.id);
      expect(cursorBefore).toBeGreaterThan(0);

      await harness.restartDaemon("cursor-restart");
      await waitForHostConnected(harness.api, RECOVERY_TIMEOUT_MS);

      await sendTextMessage(harness.api, thread.id, {
        text: "cursor second turn",
      });
      await waitForThreadStatus(harness.api, thread.id, "idle", TURN_TIMEOUT_MS);

      const cursorAfter = await readCommandCursor(harness.daemonDataDir);
      const eventsAfter = await getThreadEvents(harness.api, thread.id);
      expect(cursorAfter).toBeGreaterThan(cursorBefore);
      expect(eventsAfter.length).toBeGreaterThan(eventsBefore.length);
      assertMonotonicSequences(eventsAfter);
      expect(
        eventsAfter.filter((event) => event.type === "turn/completed"),
      ).toHaveLength(2);
    } finally {
      await harness.cleanup();
    }
  });

  it("does not revive an idle thread that was manually marked errored before reconnect", async () => {
    const harness = await createIntegrationHarness();

    try {
      const { thread } = await createRecoveryThread(
        harness,
        "Reconciliation Idle Error",
      );

      await sendTextMessage(harness.api, thread.id, {
        text: "reconciliation baseline",
      });
      await waitForThreadStatus(harness.api, thread.id, "idle", TURN_TIMEOUT_MS);

      await harness.shutdownDaemon("reconciliation-stop");
      await waitForHostDisconnected(
        harness.api,
        harness.hostId,
        RECOVERY_TIMEOUT_MS,
      );

      transitionThreadStatus(harness.db, harness.hub, thread.id, "error");

      await harness.startDaemon();
      await waitForHostConnected(harness.api, RECOVERY_TIMEOUT_MS);

      const afterReconnect = await getThread(harness.api, thread.id);
      expect(afterReconnect.status).toBe("error");
    } finally {
      await harness.cleanup();
    }
  });

  it("rejects late command results from an old session after restart", async () => {
    const harness = await createIntegrationHarness();

    try {
      const { thread } = await createRecoveryThread(
        harness,
        "Old Session Rejection",
      );
      const oldSessionId = requireSessionId(harness);

      await sendTextMessage(harness.api, thread.id, {
        text: "before session rotation",
      });
      await waitForThreadStatus(harness.api, thread.id, "idle", TURN_TIMEOUT_MS);

      await harness.restartDaemon("old-session-restart");
      await waitForHostConnected(harness.api, RECOVERY_TIMEOUT_MS);

      const oldSession = getSession(harness, oldSessionId);
      expect(oldSession?.status).toBe("closed");

      const staleResultResponse = await harness.internal.session["command-result"].$post({
        json: {
          commandId: "cmd_stale",
          completedAt: Date.now(),
          cursor: 1,
          ok: true,
          result: {
            providerThreadId: "provider-stale",
          },
          sessionId: oldSessionId,
          type: "thread.start",
        },
      });
      expect(staleResultResponse.status).toBe(401);

      await sendTextMessage(harness.api, thread.id, {
        text: "after stale session rejection",
      });
      await waitForThreadStatus(harness.api, thread.id, "idle", TURN_TIMEOUT_MS);
      expect(await getThreadOutput(harness.api, thread.id)).toContain(
        "after stale session rejection",
      );
    } finally {
      await harness.cleanup();
    }
  });

  it("drains queued work that was inserted while the daemon was offline", async () => {
    const harness = await createIntegrationHarness();

    try {
      const { environment, thread } = await createRecoveryThread(
        harness,
        "Queued Work Recovery",
      );

      await sendTextMessage(harness.api, thread.id, {
        text: "queued baseline",
      });
      await waitForThreadStatus(harness.api, thread.id, "idle", TURN_TIMEOUT_MS);

      await harness.crashDaemon();
      await waitForHostDisconnected(
        harness.api,
        harness.hostId,
        RECOVERY_TIMEOUT_MS,
      );

      const eventsBefore = await getThreadEvents(harness.api, thread.id);
      const providerThreadId =
        harness.db
          .select({ providerThreadId: events.providerThreadId })
          .from(events)
          .where(
            and(
              eq(events.threadId, thread.id),
              isNotNull(events.providerThreadId),
            ),
          )
          .orderBy(desc(events.sequence))
          .limit(1)
          .get()
          ?.providerThreadId ?? null;
      if (!providerThreadId || !environment.path) {
        throw new Error("Expected queued recovery turn to have provider context");
      }
      const queuedTurnRunCommand = hostDaemonCommandSchema.parse({
        type: "turn.run",
        environmentId: environment.id,
        threadId: thread.id,
        workspacePath: environment.path,
        projectId: thread.projectId,
        providerId: thread.providerId,
        providerThreadId,
        eventSequence: eventsBefore.length + 1,
        input: [{ type: "text", text: "queued while offline" }],
      });
      queueCommand(harness.db, harness.hub, {
        hostId: harness.hostId,
        sessionId: null,
        type: queuedTurnRunCommand.type,
        payload: JSON.stringify(queuedTurnRunCommand),
      });

      await harness.startDaemon();
      await waitForHostConnected(harness.api, RECOVERY_TIMEOUT_MS);
      await waitForEvents(
        harness.api,
        thread.id,
        eventsBefore.length + 2,
        RECOVERY_TIMEOUT_MS,
      );
      await waitForEventType(
        harness.api,
        thread.id,
        "turn/completed",
        RECOVERY_TIMEOUT_MS,
      );

      expect(await getThreadOutput(harness.api, thread.id)).toContain(
        "queued while offline",
      );
    } finally {
      await harness.cleanup();
    }
  });
});
