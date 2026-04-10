import { getThread, listEvents } from "@bb/db";
import { describe, expect, it, vi } from "vitest";
import { applyTurnCompletedEvent } from "../../src/internal/turn-completed-events.js";
import {
  pruneThreadEventHistory,
  pruneThreadEventHistoryBestEffort,
} from "../../src/services/system/event-pruning.js";
import { buildThreadTimeline } from "../../src/services/threads/timeline.js";
import { internalAuthHeaders } from "../helpers/commands.js";
import {
  seedEnvironment,
  seedHost,
  seedHostSession,
  seedProjectWithSource,
  seedStoredEvent,
  seedThread,
} from "../helpers/seed.js";
import { createTestAppHarness } from "../helpers/test-app.js";

interface SeedNoiseRowsArgs {
  endingSequence: number;
  startingSequence?: number;
  threadId: string;
}

interface CreateTokenUsageDataArgs {
  modelContextWindow: number | null;
  totalTokens: number;
}

interface CreateContextWindowUsageDataArgs {
  estimated?: boolean;
  modelContextWindow: number | null;
  usedTokens: number | null;
}

function createTokenUsageData(args: CreateTokenUsageDataArgs): Record<string, unknown> {
  return {
    tokenUsage: {
      total: {
        totalTokens: args.totalTokens,
        inputTokens: args.totalTokens,
        cachedInputTokens: 0,
        outputTokens: 0,
        reasoningOutputTokens: 0,
      },
      last: {
        totalTokens: args.totalTokens,
        inputTokens: args.totalTokens,
        cachedInputTokens: 0,
        outputTokens: 0,
        reasoningOutputTokens: 0,
      },
      modelContextWindow: args.modelContextWindow,
    },
  };
}

function createContextWindowUsageData(
  args: CreateContextWindowUsageDataArgs,
): Record<string, unknown> {
  return {
    contextWindowUsage: {
      usedTokens: args.usedTokens,
      modelContextWindow: args.modelContextWindow,
      estimated: args.estimated ?? false,
    },
  };
}

function listEventSequencesForType(
  harness: Awaited<ReturnType<typeof createTestAppHarness>>,
  args: { itemId?: string; threadId: string; type: string },
): number[] {
  return listEvents(harness.db, {
    threadId: args.threadId,
  })
    .filter((event) =>
      event.type === args.type &&
      (args.itemId === undefined || event.itemId === args.itemId),
    )
    .map((event) => event.sequence);
}

function seedNoiseRows(
  harness: Awaited<ReturnType<typeof createTestAppHarness>>,
  args: SeedNoiseRowsArgs,
): void {
  const startingSequence = args.startingSequence ?? 1;
  for (
    let sequence = startingSequence;
    sequence <= args.endingSequence;
    sequence += 1
  ) {
    seedStoredEvent(harness.deps, {
      threadId: args.threadId,
      providerThreadId: "provider-thread-1",
      sequence,
      turnId: `turn-${sequence}`,
      type: "thread/tokenUsage/updated",
      itemId: null,
      itemKind: null,
      data: createTokenUsageData({
        totalTokens: sequence,
        modelContextWindow: null,
      }),
    });
  }
}

function seedResolvedAssistantMessage(
  harness: Awaited<ReturnType<typeof createTestAppHarness>>,
  args: {
    completedSequence: number;
    deltaSequences: readonly number[];
    itemId: string;
    threadId: string;
  },
): void {
  for (const sequence of args.deltaSequences) {
    seedStoredEvent(harness.deps, {
      threadId: args.threadId,
      sequence,
      type: "item/agentMessage/delta",
      itemId: args.itemId,
      itemKind: null,
      data: {
        itemId: args.itemId,
        delta: `chunk-${sequence}`,
      },
    });
  }

  seedStoredEvent(harness.deps, {
    threadId: args.threadId,
    sequence: args.completedSequence,
    type: "item/completed",
    itemId: args.itemId,
    itemKind: "agentMessage",
    data: {
      item: {
        id: args.itemId,
        type: "agentMessage",
        text: "Final answer",
      },
    },
  });
}

describe("thread event pruning", () => {
  it("prunes idle-thread noise rows and resolved item deltas", async () => {
    const harness = await createTestAppHarness();
    try {
      const host = seedHost(harness.deps);
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

      seedNoiseRows(harness, {
        threadId: thread.id,
        endingSequence: 305,
      });
      seedResolvedAssistantMessage(harness, {
        threadId: thread.id,
        itemId: "msg-1",
        deltaSequences: [306, 307, 308],
        completedSequence: 309,
      });

      const result = pruneThreadEventHistory(harness.deps, {
        mode: "idle",
        threadId: thread.id,
      });

      expect(result).toMatchObject({
        latestSequence: 309,
        sequenceCutoff: 9,
        removedAgePrunableEvents: 9,
        removedResolvedItemDeltas: 2,
        totalRemoved: 11,
      });
      expect(
        listEventSequencesForType(harness, {
          threadId: thread.id,
          type: "thread/tokenUsage/updated",
        }).at(0),
      ).toBe(10);
      expect(
        listEventSequencesForType(harness, {
          threadId: thread.id,
          type: "item/agentMessage/delta",
        }),
      ).toEqual([306]);
    } finally {
      await harness.cleanup();
    }
  });

  it("preserves context window usage when idle pruning removes old context-usage rows", async () => {
    const harness = await createTestAppHarness();
    try {
      const host = seedHost(harness.deps);
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

      for (let sequence = 1; sequence <= 305; sequence += 1) {
        seedStoredEvent(harness.deps, {
          threadId: thread.id,
          providerThreadId: "provider-thread-1",
          sequence,
          turnId: `turn-${sequence}`,
          type: "thread/contextWindowUsage/updated",
          itemId: null,
          itemKind: null,
          data: createContextWindowUsageData({
            usedTokens: sequence,
            modelContextWindow: sequence === 1 ? 200_000 : null,
            estimated: sequence !== 1,
          }),
        });
      }

      const result = pruneThreadEventHistory(harness.deps, {
        mode: "idle",
        threadId: thread.id,
      });
      const timeline = buildThreadTimeline(harness.db, thread, {});

      expect(result.removedAgePrunableEvents).toBe(4);
      expect(
        listEventSequencesForType(harness, {
          threadId: thread.id,
          type: "thread/contextWindowUsage/updated",
        }).slice(0, 3),
      ).toEqual([1, 6, 7]);
      expect(timeline.contextWindowUsage).toEqual({
        usedTokens: 305,
        modelContextWindow: 200_000,
        estimated: true,
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("prunes thread history when turn completion returns the thread to idle", async () => {
    const harness = await createTestAppHarness();
    try {
      const host = seedHost(harness.deps);
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
        status: "active",
      });

      seedNoiseRows(harness, {
        threadId: thread.id,
        endingSequence: 305,
      });
      seedResolvedAssistantMessage(harness, {
        threadId: thread.id,
        itemId: "msg-1",
        deltaSequences: [306, 307],
        completedSequence: 308,
      });
      seedStoredEvent(harness.deps, {
        threadId: thread.id,
        sequence: 309,
        type: "turn/completed",
        itemId: null,
        itemKind: null,
        data: {
          status: "completed",
        },
      });

      applyTurnCompletedEvent(harness.deps, {
        type: "turn/completed",
        threadId: thread.id,
        providerThreadId: "provider-thread-1",
        turnId: "turn-1",
        status: "completed",
      });

      expect(getThread(harness.db, thread.id)?.status).toBe("idle");
      expect(
        listEventSequencesForType(harness, {
          threadId: thread.id,
          type: "thread/tokenUsage/updated",
        }).at(0),
      ).toBe(10);
      expect(
        listEventSequencesForType(harness, {
          threadId: thread.id,
          type: "item/agentMessage/delta",
        }),
      ).toEqual([306]);
    } finally {
      await harness.cleanup();
    }
  });

  it("prunes thread history on archive with the archived retention window", async () => {
    const harness = await createTestAppHarness();
    try {
      const host = seedHost(harness.deps);
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
        status: "idle",
      });

      seedNoiseRows(harness, {
        threadId: thread.id,
        endingSequence: 130,
      });
      seedResolvedAssistantMessage(harness, {
        threadId: thread.id,
        itemId: "msg-1",
        deltaSequences: [131, 132],
        completedSequence: 133,
      });

      const response = await harness.app.request(
        `/api/v1/threads/${thread.id}/archive`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({ force: true }),
        },
      );

      expect(response.status).toBe(200);
      expect(getThread(harness.db, thread.id)?.archivedAt).toBeTypeOf("number");
      expect(
        listEventSequencesForType(harness, {
          threadId: thread.id,
          type: "thread/tokenUsage/updated",
        }).at(0),
      ).toBe(14);
      expect(
        listEventSequencesForType(harness, {
          threadId: thread.id,
          type: "item/agentMessage/delta",
        }),
      ).toEqual([131]);
    } finally {
      await harness.cleanup();
    }
  });

  it("logs and returns null when best-effort pruning cannot run", async () => {
    const harness = await createTestAppHarness();
    try {
      const host = seedHost(harness.deps);
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
      const loggerWarn = vi.fn();
      harness.deps.logger.warn = loggerWarn;

      harness.db.$client.close();

      expect(
        pruneThreadEventHistoryBestEffort(harness.deps, {
          mode: "idle",
          threadId: thread.id,
        }),
      ).toBeNull();
      expect(loggerWarn).toHaveBeenCalledTimes(1);
    } finally {
      await harness.cleanup();
    }
  });

  it("prunes active-thread noise rows after ingest without dropping unresolved deltas", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host, session } = seedHostSession(harness.deps);
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
        status: "active",
      });

      seedNoiseRows(harness, {
        threadId: thread.id,
        endingSequence: 1_000,
      });
      seedResolvedAssistantMessage(harness, {
        threadId: thread.id,
        itemId: "msg-completed",
        deltaSequences: [1_001, 1_002],
        completedSequence: 1_003,
      });
      for (const sequence of [1_004, 1_005]) {
        seedStoredEvent(harness.deps, {
          threadId: thread.id,
          sequence,
          type: "item/agentMessage/delta",
          itemId: "msg-active",
          itemKind: null,
          data: {
            itemId: "msg-active",
            delta: `chunk-${sequence}`,
          },
        });
      }

      const response = await harness.app.request("/internal/session/events", {
        method: "POST",
        headers: internalAuthHeaders(harness),
        body: JSON.stringify({
          sessionId: session.id,
          events: [
            {
              environmentId: environment.id,
              threadId: thread.id,
              sequence: 1_006,
              createdAt: Date.now(),
              event: {
                type: "thread/tokenUsage/updated",
                threadId: thread.id,
                providerThreadId: "provider-thread-1",
                turnId: "turn-1",
                tokenUsage: {
                  total: {
                    totalTokens: 1,
                    inputTokens: 1,
                    cachedInputTokens: 0,
                    outputTokens: 0,
                    reasoningOutputTokens: 0,
                  },
                  last: {
                    totalTokens: 1,
                    inputTokens: 1,
                    cachedInputTokens: 0,
                    outputTokens: 0,
                    reasoningOutputTokens: 0,
                  },
                  modelContextWindow: 200_000,
                },
              },
            },
          ],
        }),
      });

      expect(response.status).toBe(200);
      expect(
        listEventSequencesForType(harness, {
          threadId: thread.id,
          type: "thread/tokenUsage/updated",
        }).at(0),
      ).toBe(7);
      expect(
        listEventSequencesForType(harness, {
          threadId: thread.id,
          type: "item/agentMessage/delta",
          itemId: "msg-completed",
        }),
      ).toEqual([1_001]);
      expect(
        listEventSequencesForType(harness, {
          threadId: thread.id,
          type: "item/agentMessage/delta",
          itemId: "msg-active",
        }),
      ).toEqual([1_004, 1_005]);
    } finally {
      await harness.cleanup();
    }
  });
});
