import { eq } from "drizzle-orm";
import { events, getThread, threads } from "@bb/db";
import {
  createStandaloneBuiltinCompactCommandInput,
  threadScope,
  turnScope,
} from "@bb/domain";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  appendClientTurnEvent,
  appendThreadEvent,
  appendThreadEventInTransaction,
  appendThreadEventsInTransaction,
  isManualCompactionActive,
} from "../../../src/services/threads/thread-events.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
} from "../../helpers/seed.js";
import { textInput } from "../../helpers/prompt-input.js";
import { createTestAppHarness } from "../../helpers/test-app.js";

async function createThreadEventTestContext() {
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
  });

  return { environment, harness, thread };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("thread event appends", () => {
  it("does not classify an accepted compact steer as manual compaction", async () => {
    const { environment, harness, thread } =
      await createThreadEventTestContext();
    try {
      harness.db
        .update(threads)
        .set({ status: "active" })
        .where(eq(threads.id, thread.id))
        .run();
      const turnId = "turn-active";
      const providerThreadId = "provider-thread-active";
      const initialRequest = appendClientTurnEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        type: "client/turn/requested",
        input: textInput("Keep working"),
        target: { kind: "new-turn" },
        execution: {
          model: "gpt-5",
          reasoningLevel: "medium",
          permissionMode: "full",
          serviceTier: "default",
          source: "client/turn/requested",
        },
        initiator: "user",
        senderThreadId: null,
        requestMethod: "turn/start",
        source: "tell",
      });
      appendThreadEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        type: "turn/started",
        scope: turnScope(turnId),
        data: { providerThreadId },
      });
      appendThreadEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        type: "turn/input/accepted",
        scope: turnScope(turnId),
        data: {
          providerThreadId,
          clientRequestId: initialRequest.requestId,
        },
      });
      const compactSteer = appendClientTurnEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        type: "client/turn/requested",
        input: createStandaloneBuiltinCompactCommandInput(),
        target: { kind: "steer", expectedTurnId: turnId },
        execution: {
          model: "gpt-5",
          reasoningLevel: "medium",
          permissionMode: "full",
          serviceTier: "default",
          source: "client/turn/requested",
        },
        initiator: "user",
        senderThreadId: null,
        requestMethod: "turn/start",
        source: "tell",
      });
      appendThreadEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        type: "turn/input/accepted",
        scope: turnScope(turnId),
        data: {
          providerThreadId,
          clientRequestId: compactSteer.requestId,
        },
      });

      const activeThread = getThread(harness.db, thread.id);
      if (!activeThread) {
        throw new Error("Expected active thread");
      }
      expect(isManualCompactionActive(harness.deps, activeThread)).toBe(false);
    } finally {
      await harness.cleanup();
    }
  });

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

  it("advances lastReadAt and notifies read-state-changed for a user-initiated turn request", async () => {
    const { environment, harness, thread } =
      await createThreadEventTestContext();
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
      const notifyThreadSpy = vi.spyOn(harness.deps.hub, "notifyThread");

      appendClientTurnEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        type: "client/turn/requested",
        input: textInput("kick off the audit"),
        target: { kind: "new-turn" },
        execution: {
          model: "gpt-5",
          reasoningLevel: "medium",
          permissionMode: "full",
          serviceTier: "default",
          source: "client/turn/requested",
        },
        initiator: "user",
        senderThreadId: null,
        requestMethod: "turn/start",
        source: "tell",
      });

      expect(getThread(harness.db, thread.id)?.lastReadAt).toBe(2_000);
      expect(notifyThreadSpy).toHaveBeenCalledWith(
        thread.id,
        ["events-appended", "read-state-changed"],
        {
          eventTypes: ["client/turn/requested"],
          projectId: thread.projectId,
        },
      );
    } finally {
      await harness.cleanup();
    }
  });

  it("does not advance lastReadAt for an agent-initiated turn request", async () => {
    const { environment, harness, thread } =
      await createThreadEventTestContext();
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
      const notifyThreadSpy = vi.spyOn(harness.deps.hub, "notifyThread");

      appendClientTurnEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        type: "client/turn/requested",
        input: textInput("agent handoff"),
        target: { kind: "new-turn" },
        execution: {
          model: "gpt-5",
          reasoningLevel: "medium",
          permissionMode: "full",
          serviceTier: "default",
          source: "client/turn/requested",
        },
        initiator: "agent",
        senderThreadId: "thr_sender",
        requestMethod: "turn/start",
        source: "tell",
      });

      expect(getThread(harness.db, thread.id)?.lastReadAt).toBe(1_000);
      expect(notifyThreadSpy).toHaveBeenCalledWith(
        thread.id,
        ["events-appended"],
        { eventTypes: ["client/turn/requested"] },
      );
    } finally {
      await harness.cleanup();
    }
  });
});
