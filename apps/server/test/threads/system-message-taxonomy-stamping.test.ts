import { and, eq } from "drizzle-orm";
import { events } from "@bb/db";
import {
  turnRequestEventDataSchema,
  type SystemMessageKind,
  type SystemMessageSubject,
  type ThreadEventTurnStatus,
} from "@bb/domain";
import { describe, expect, it } from "vitest";
import {
  queueChildThreadNeedsAttentionNotificationBestEffort,
  queueChildThreadTurnNotificationBestEffort,
} from "../../src/services/threads/child-thread-notifications.js";
import { handleThreadOwnershipChange } from "../../src/services/threads/thread-ownership.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
  seedThreadRuntimeState,
} from "../helpers/seed.js";
import { createTestAppHarness, withTestHarness } from "../helpers/test-app.js";

type TestHarness = Awaited<ReturnType<typeof createTestAppHarness>>;

interface ParentFixture {
  hostId: string;
  parentThreadId: string;
  projectId: string;
}

function seedParentFixture(
  harness: TestHarness,
  hostId: string,
): ParentFixture {
  const { host } = seedHostSession(harness.deps, { id: hostId });
  const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
  const environment = seedEnvironment(harness.deps, {
    hostId: host.id,
    projectId: project.id,
    path: `/tmp/${hostId}-environment`,
  });
  const parent = seedThread(harness.deps, {
    projectId: project.id,
    environmentId: environment.id,
    title: "Manager",
  });
  seedThreadRuntimeState(harness.deps, {
    threadId: parent.id,
    environmentId: environment.id,
    providerThreadId: `provider-${hostId}`,
    inputText: "Manage things",
    model: "fake-model",
  });
  return {
    hostId: host.id,
    parentThreadId: parent.id,
    projectId: project.id,
  };
}

interface StampedSystemMessage {
  systemMessageKind: SystemMessageKind;
  systemMessageSubject: SystemMessageSubject | null;
}

async function waitForStampedSystemMessage(
  harness: TestHarness,
  parentThreadId: string,
  timeoutMs = 4_000,
): Promise<StampedSystemMessage> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = harness.db
      .select()
      .from(events)
      .where(
        and(
          eq(events.threadId, parentThreadId),
          eq(events.type, "client/turn/requested"),
        ),
      )
      .orderBy(events.sequence)
      .all();
    for (const row of rows) {
      const data = turnRequestEventDataSchema.parse(JSON.parse(row.data));
      if (data.initiator === "system") {
        return {
          systemMessageKind: data.systemMessageKind ?? "unlabeled",
          systemMessageSubject: data.systemMessageSubject ?? null,
        };
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for a stamped system message");
}

describe("Family B emit-site discriminator stamping", () => {
  const childTurnStatuses: ReadonlyArray<{
    turnStatus: ThreadEventTurnStatus;
    expectedKind: SystemMessageKind;
  }> = [
    { turnStatus: "completed", expectedKind: "child-completed" },
    { turnStatus: "failed", expectedKind: "child-failed" },
    { turnStatus: "interrupted", expectedKind: "child-interrupted" },
  ];

  for (const { turnStatus, expectedKind } of childTurnStatuses) {
    it(`stamps a single ${turnStatus} child outcome as ${expectedKind}`, async () => {
      await withTestHarness(async (harness) => {
        const fixture = seedParentFixture(harness, `host-child-${turnStatus}`);
        const child = seedThread(harness.deps, {
          projectId: fixture.projectId,
          title: "Worker child",
          parentThreadId: fixture.parentThreadId,
        });

        await queueChildThreadTurnNotificationBestEffort(harness.deps, {
          childThread: child,
          parentThreadId: fixture.parentThreadId,
          turnStatus,
        });

        const stamped = await waitForStampedSystemMessage(
          harness,
          fixture.parentThreadId,
        );
        expect(stamped.systemMessageKind).toBe(expectedKind);
        expect(stamped.systemMessageSubject).toEqual({
          kind: "thread",
          threadId: child.id,
          threadName: "Worker child",
        });
      });
    });
  }

  it("stamps a multi-child batch as child-outcome-batch with a count subject", async () => {
    await withTestHarness(async (harness) => {
      const fixture = seedParentFixture(harness, "host-child-batch");
      const childA = seedThread(harness.deps, {
        projectId: fixture.projectId,
        title: "Worker A",
        parentThreadId: fixture.parentThreadId,
      });
      const childB = seedThread(harness.deps, {
        projectId: fixture.projectId,
        title: "Worker B",
        parentThreadId: fixture.parentThreadId,
      });

      await queueChildThreadTurnNotificationBestEffort(harness.deps, {
        childThread: childA,
        parentThreadId: fixture.parentThreadId,
        turnStatus: "completed",
      });
      await queueChildThreadTurnNotificationBestEffort(harness.deps, {
        childThread: childB,
        parentThreadId: fixture.parentThreadId,
        turnStatus: "interrupted",
      });

      const stamped = await waitForStampedSystemMessage(
        harness,
        fixture.parentThreadId,
      );
      expect(stamped.systemMessageKind).toBe("child-outcome-batch");
      expect(stamped.systemMessageSubject).toEqual({
        kind: "thread-batch",
        count: 2,
      });
    });
  });

  it("stamps a needs-attention notification as child-needs-attention", async () => {
    await withTestHarness(async (harness) => {
      const fixture = seedParentFixture(harness, "host-child-attention");
      const child = seedThread(harness.deps, {
        projectId: fixture.projectId,
        title: "Blocked child",
        parentThreadId: fixture.parentThreadId,
      });

      await queueChildThreadNeedsAttentionNotificationBestEffort(harness.deps, {
        childThread: child,
        parentThreadId: fixture.parentThreadId,
        blockerSummary: null,
      });

      const stamped = await waitForStampedSystemMessage(
        harness,
        fixture.parentThreadId,
      );
      expect(stamped.systemMessageKind).toBe("child-needs-attention");
      expect(stamped.systemMessageSubject).toEqual({
        kind: "thread",
        threadId: child.id,
        threadName: "Blocked child",
      });
    });
  });

  it("stamps ownership assignment as ownership-assigned naming the child", async () => {
    await withTestHarness(async (harness) => {
      const fixture = seedParentFixture(harness, "host-ownership-assign");
      const child = seedThread(harness.deps, {
        projectId: fixture.projectId,
        title: "Assigned child",
        parentThreadId: fixture.parentThreadId,
      });

      await handleThreadOwnershipChange(harness.deps, {
        previousThread: { ...child, parentThreadId: null },
        updatedThread: { ...child, parentThreadId: fixture.parentThreadId },
      });

      const stamped = await waitForStampedSystemMessage(
        harness,
        fixture.parentThreadId,
      );
      expect(stamped.systemMessageKind).toBe("ownership-assigned");
      expect(stamped.systemMessageSubject).toEqual({
        kind: "thread",
        threadId: child.id,
        threadName: "Assigned child",
      });
    });
  });

  it("stamps ownership removal as ownership-removed naming the child", async () => {
    await withTestHarness(async (harness) => {
      const fixture = seedParentFixture(harness, "host-ownership-remove");
      const child = seedThread(harness.deps, {
        projectId: fixture.projectId,
        title: "Released child",
        parentThreadId: null,
      });

      await handleThreadOwnershipChange(harness.deps, {
        previousThread: { ...child, parentThreadId: fixture.parentThreadId },
        updatedThread: { ...child, parentThreadId: null },
      });

      const stamped = await waitForStampedSystemMessage(
        harness,
        fixture.parentThreadId,
      );
      expect(stamped.systemMessageKind).toBe("ownership-removed");
      expect(stamped.systemMessageSubject).toEqual({
        kind: "thread",
        threadId: child.id,
        threadName: "Released child",
      });
    });
  });
});
