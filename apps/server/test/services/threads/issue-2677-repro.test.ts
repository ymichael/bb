import { and, eq } from "drizzle-orm";
import { events, getThread } from "@bb/db";
import { turnRequestEventDataSchema, turnScope } from "@bb/domain";
import {
  groupHostDaemonEvents,
  type HostDaemonEventEnvelope,
} from "@bb/host-daemon-contract";
import { describe, expect, it } from "vitest";
import { queueChildThreadTurnNotificationBestEffort } from "../../../src/services/threads/child-thread-notifications.js";
import { sendThreadMessage } from "../../../src/services/threads/thread-send.js";
import {
  internalAuthHeaders,
  reportQueuedCommandError,
  waitForQueuedCommand,
} from "../../helpers/commands.js";
import { textInput } from "../../helpers/prompt-input.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
  seedThreadRuntimeState,
} from "../../helpers/seed.js";
import {
  withTestHarness,
  type TestAppHarness,
} from "../../helpers/test-app.js";

interface FamilyFixture {
  child: ReturnType<typeof seedThread>;
  environment: ReturnType<typeof seedEnvironment>;
  parent: ReturnType<typeof seedThread>;
  sessionId: string;
}

function seedFamily(harness: TestAppHarness, suffix: string): FamilyFixture {
  const { host, session } = seedHostSession(harness.deps, {
    id: `host-${suffix}`,
  });
  const { project } = seedProjectWithSource(harness.deps, {
    hostId: host.id,
  });
  const environment = seedEnvironment(harness.deps, {
    hostId: host.id,
    projectId: project.id,
  });
  const parent = seedThread(harness.deps, {
    environmentId: environment.id,
    projectId: project.id,
    title: "Parent",
  });
  seedThreadRuntimeState(harness.deps, {
    environmentId: environment.id,
    providerThreadId: `provider-parent-${suffix}`,
    threadId: parent.id,
  });
  const child = seedThread(harness.deps, {
    environmentId: environment.id,
    parentThreadId: parent.id,
    projectId: project.id,
    title: "Child",
  });
  seedThreadRuntimeState(harness.deps, {
    environmentId: environment.id,
    providerThreadId: `provider-child-${suffix}`,
    threadId: child.id,
  });
  return {
    child,
    environment,
    parent,
    sessionId: session.id,
  };
}

async function postEventBatch(args: {
  events: HostDaemonEventEnvelope[];
  harness: TestAppHarness;
  sessionId: string;
}): Promise<Response> {
  return args.harness.app.request("/internal/session/events", {
    method: "POST",
    headers: internalAuthHeaders(args.harness),
    body: JSON.stringify({
      sessionId: args.sessionId,
      eventGroups: groupHostDaemonEvents(args.events),
    }),
  });
}

function parentSystemMessageKinds(
  harness: TestAppHarness,
  parentThreadId: string,
): string[] {
  return harness.db
    .select()
    .from(events)
    .where(
      and(
        eq(events.threadId, parentThreadId),
        eq(events.type, "client/turn/requested"),
      ),
    )
    .all()
    .flatMap((row) => {
      const data = turnRequestEventDataSchema.parse(JSON.parse(row.data));
      return data.initiator === "system" && data.systemMessageKind
        ? [data.systemMessageKind]
        : [];
    });
}

describe("child outcome reconciliation", () => {
  it("does not report a failed outcome after a later accepted turn becomes active", async () => {
    await withTestHarness(async (harness) => {
      const fixture = seedFamily(harness, "late-acceptance");
      await sendThreadMessage(harness.deps, {
        environment: fixture.environment,
        payload: {
          input: textInput("continue"),
          mode: "start",
          model: "gpt-5",
          permissionMode: "full",
          reasoningLevel: "medium",
          serviceTier: "default",
        },
        thread: fixture.child,
        trigger: "user",
      });
      const queued = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "turn.submit" &&
          command.threadId === fixture.child.id,
      );
      if (queued.command.type !== "turn.submit") {
        throw new Error("Expected a turn submission");
      }

      await reportQueuedCommandError(harness, queued, {
        errorCode: "command_timeout",
        errorMessage: "Timed out waiting for command result",
      });
      expect(getThread(harness.db, fixture.child.id)?.status).toBe("active");
      const turnId = "turn-late-acceptance";
      const response = await postEventBatch({
        harness,
        sessionId: fixture.sessionId,
        events: [
          {
            threadId: fixture.child.id,
            event: {
              type: "turn/started",
              threadId: fixture.child.id,
              providerThreadId: `provider-child-late-acceptance`,
              scope: turnScope(turnId),
            },
          },
          {
            threadId: fixture.child.id,
            event: {
              type: "turn/input/accepted",
              threadId: fixture.child.id,
              providerThreadId: `provider-child-late-acceptance`,
              scope: turnScope(turnId),
              clientRequestId: queued.command.requestId,
            },
          },
        ],
      });
      expect(response.status).toBe(200);
      expect(getThread(harness.db, fixture.child.id)?.status).toBe("active");

      await new Promise((resolve) => setTimeout(resolve, 2_100));

      expect(getThread(harness.db, fixture.child.id)?.status).toBe("active");
      expect(parentSystemMessageKinds(harness, fixture.parent.id)).toEqual([]);
    });
  });

  it("keeps one outcome when the same child is queued twice", async () => {
    await withTestHarness(async (harness) => {
      const fixture = seedFamily(harness, "duplicate");
      for (let index = 0; index < 2; index += 1) {
        await queueChildThreadTurnNotificationBestEffort(harness.deps, {
          childThread: fixture.child,
          parentThreadId: fixture.parent.id,
          turnStatus: "failed",
        });
      }

      await new Promise((resolve) => setTimeout(resolve, 2_100));

      expect(parentSystemMessageKinds(harness, fixture.parent.id)).toEqual([
        "child-failed",
      ]);
    });
  });
});
