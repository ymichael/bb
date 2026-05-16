import { eq } from "drizzle-orm";
import { events, getThread, threads } from "@bb/db";
import { threadScope, turnScope } from "@bb/domain";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  appendThreadEvent,
  appendThreadEventInTransaction,
  appendThreadEventsInTransaction,
} from "../../../src/services/threads/thread-events.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
} from "../../helpers/seed.js";
import { createTestAppHarness } from "../../helpers/test-app.js";

interface CreateThreadEventTestContextArgs {
  threadType?: "standard" | "manager";
}

async function createThreadEventTestContext(
  args: CreateThreadEventTestContextArgs = {},
) {
  const harness = await createTestAppHarness();
  const { host } = seedHostSession(harness.deps);
  const { project } = seedProjectWithSource(harness.deps, {
    hostId: host.id,
  });
  const environment = seedEnvironment(harness.deps, {
    hostId: host.id,
    projectId: project.id,
  });
  const thread = seedThread(harness.deps, {
    projectId: project.id,
    environmentId: environment.id,
    type: args.threadType ?? "standard",
  });

  return { environment, harness, thread };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("thread event appends", () => {
  it("rejects direct turn-scoped appends before turn/started is stored", async () => {
    const { environment, harness, thread } =
      await createThreadEventTestContext();
    try {
      expect(() =>
        appendThreadEvent(harness.deps, {
          threadId: thread.id,
          environmentId: environment.id,
          type: "system/error",
          scope: turnScope("turn-missing"),
          data: { message: "Late failure" },
        }),
      ).toThrow("before turn/started is stored");
      expect(
        harness.db
          .select()
          .from(events)
          .where(eq(events.threadId, thread.id))
          .all(),
      ).toHaveLength(0);
    } finally {
      await harness.cleanup();
    }
  });

  it("rejects singular transactional turn-scoped appends before turn/started is stored", async () => {
    const { environment, harness, thread } =
      await createThreadEventTestContext();
    try {
      expect(() =>
        harness.db.transaction((tx) =>
          appendThreadEventInTransaction(tx, {
            threadId: thread.id,
            environmentId: environment.id,
            type: "system/error",
            scope: turnScope("turn-missing-transaction"),
            data: { message: "Transactional late failure" },
          }),
        ),
      ).toThrow("before turn/started is stored");
      expect(
        harness.db
          .select()
          .from(events)
          .where(eq(events.threadId, thread.id))
          .all(),
      ).toHaveLength(0);
    } finally {
      await harness.cleanup();
    }
  });

  it("accepts thread-scoped appends before turn/started is stored", async () => {
    const { environment, harness, thread } =
      await createThreadEventTestContext();
    try {
      const sequence = appendThreadEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        type: "system/error",
        scope: threadScope(),
        data: { message: "Thread-level failure" },
      });

      expect(sequence).toBe(1);
      expect(
        harness.db
          .select({ scopeKind: events.scopeKind, type: events.type })
          .from(events)
          .where(eq(events.threadId, thread.id))
          .all(),
      ).toEqual([{ scopeKind: "thread", type: "system/error" }]);
    } finally {
      await harness.cleanup();
    }
  });

  it("gates distinct turns in the same thread independently", async () => {
    const { environment, harness, thread } =
      await createThreadEventTestContext();
    try {
      appendThreadEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        providerThreadId: "provider-turn-a",
        type: "turn/started",
        scope: turnScope("turn-a"),
        data: { providerThreadId: "provider-turn-a" },
      });

      expect(() =>
        appendThreadEvent(harness.deps, {
          threadId: thread.id,
          environmentId: environment.id,
          type: "system/error",
          scope: turnScope("turn-b"),
          data: { message: "Wrong turn failure" },
        }),
      ).toThrow("before turn/started is stored");
      expect(
        harness.db
          .select({ turnId: events.turnId, type: events.type })
          .from(events)
          .where(eq(events.threadId, thread.id))
          .all(),
      ).toEqual([{ turnId: "turn-a", type: "turn/started" }]);
    } finally {
      await harness.cleanup();
    }
  });

  it("rejects batched turn-scoped appends when turn/started is missing", async () => {
    const { environment, harness, thread } =
      await createThreadEventTestContext();
    try {
      expect(() =>
        harness.db.transaction((tx) =>
          appendThreadEventsInTransaction(tx, [
            {
              threadId: thread.id,
              environmentId: environment.id,
              type: "system/error",
              scope: turnScope("turn-missing-batch"),
              data: { message: "Batched late failure" },
            },
          ]),
        ),
      ).toThrow("before turn/started is stored");
      expect(
        harness.db
          .select()
          .from(events)
          .where(eq(events.threadId, thread.id))
          .all(),
      ).toHaveLength(0);
    } finally {
      await harness.cleanup();
    }
  });

  it("rejects batched turn-scoped appends before turn/started in the same batch", async () => {
    const { environment, harness, thread } =
      await createThreadEventTestContext();
    try {
      expect(() =>
        harness.db.transaction((tx) =>
          appendThreadEventsInTransaction(tx, [
            {
              threadId: thread.id,
              environmentId: environment.id,
              type: "system/error",
              scope: turnScope("turn-late-start"),
              data: { message: "Ordered batch failure" },
            },
            {
              threadId: thread.id,
              environmentId: environment.id,
              providerThreadId: "provider-late-start",
              type: "turn/started",
              scope: turnScope("turn-late-start"),
              data: { providerThreadId: "provider-late-start" },
            },
          ]),
        ),
      ).toThrow("before turn/started is stored");
      expect(
        harness.db
          .select()
          .from(events)
          .where(eq(events.threadId, thread.id))
          .all(),
      ).toHaveLength(0);
    } finally {
      await harness.cleanup();
    }
  });

  it("accepts turn-scoped appends after an earlier turn/started in the same transaction", async () => {
    const { environment, harness, thread } =
      await createThreadEventTestContext();
    try {
      const sequences = harness.db.transaction((tx) =>
        appendThreadEventsInTransaction(tx, [
          {
            threadId: thread.id,
            environmentId: environment.id,
            providerThreadId: "provider-batched-turn",
            type: "turn/started",
            scope: turnScope("turn-batched"),
            data: { providerThreadId: "provider-batched-turn" },
          },
          {
            threadId: thread.id,
            environmentId: environment.id,
            type: "system/error",
            scope: turnScope("turn-batched"),
            data: { message: "Batched failure" },
          },
        ]),
      );

      expect(sequences).toEqual([1, 2]);
      expect(
        harness.db
          .select({ type: events.type })
          .from(events)
          .where(eq(events.threadId, thread.id))
          .orderBy(events.sequence)
          .all(),
      ).toEqual([{ type: "turn/started" }, { type: "system/error" }]);
    } finally {
      await harness.cleanup();
    }
  });

  it("updates manager attention before notifying that a user-visible manager event was appended", async () => {
    const { harness, thread } = await createThreadEventTestContext({
      threadType: "manager",
    });
    try {
      harness.db
        .update(threads)
        .set({
          lastReadAt: 1_000,
          latestAttentionAt: 1_000,
          updatedAt: 1_000,
        })
        .where(eq(threads.id, thread.id))
        .run();
      vi.spyOn(Date, "now").mockReturnValue(2_000);
      const attentionAtNotification: number[] = [];
      const notifyThreadSpy = vi
        .spyOn(harness.deps.hub, "notifyThread")
        .mockImplementation((threadId, changes) => {
          if (threadId !== thread.id || !changes.includes("events-appended")) {
            return;
          }
          const notifiedThread = getThread(harness.db, thread.id);
          if (notifiedThread) {
            attentionAtNotification.push(notifiedThread.latestAttentionAt);
          }
        });

      const sequence = appendThreadEvent(harness.deps, {
        threadId: thread.id,
        environmentId: null,
        type: "system/manager/user_message",
        scope: threadScope(),
        data: {
          text: "Please review this update.",
        },
      });

      expect(sequence).toBe(1);
      expect(attentionAtNotification).toEqual([2_000]);
      expect(notifyThreadSpy).toHaveBeenCalledWith(
        thread.id,
        ["events-appended", "read-state-changed"],
        {
          eventTypes: ["system/manager/user_message"],
          projectId: thread.projectId,
        },
      );
    } finally {
      await harness.cleanup();
    }
  });

  it("updates manager attention inside batched transactional appends", async () => {
    const { harness, thread } = await createThreadEventTestContext({
      threadType: "manager",
    });
    try {
      harness.db
        .update(threads)
        .set({
          lastReadAt: 1_000,
          latestAttentionAt: 1_000,
          updatedAt: 1_000,
        })
        .where(eq(threads.id, thread.id))
        .run();
      vi.spyOn(Date, "now").mockReturnValue(2_000);

      const sequences = harness.db.transaction((tx) =>
        appendThreadEventsInTransaction(tx, [
          {
            threadId: thread.id,
            environmentId: null,
            type: "system/manager/user_message",
            scope: threadScope(),
            data: {
              text: "Transactional update.",
            },
          },
        ]),
      );

      expect(sequences).toEqual([1]);
      expect(getThread(harness.db, thread.id)?.latestAttentionAt).toBe(2_000);
    } finally {
      await harness.cleanup();
    }
  });
});
