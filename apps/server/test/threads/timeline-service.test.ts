import { afterEach, describe, expect, it } from "vitest";
import { createTestAppHarness } from "../helpers/test-app.js";
import {
  seedEnvironment,
  seedEvent,
  seedHost,
  seedProjectWithSource,
  seedThread,
} from "../helpers/seed.js";
import { getTimelineBenchmarkScenarios } from "../helpers/timeline-benchmark.js";
import { buildThreadTimeline } from "../../src/services/threads/timeline.js";

describe("buildThreadTimeline", () => {
  const scenarios = getTimelineBenchmarkScenarios();
  const harnesses: Array<Awaited<ReturnType<typeof createTestAppHarness>>> = [];

  afterEach(async () => {
    while (harnesses.length > 0) {
      const harness = harnesses.pop();
      if (!harness) {
        continue;
      }
      await harness.cleanup();
    }
  });

  for (const scenario of scenarios) {
    it(`keeps the summary payload smaller than the full grouped payload for ${scenario.id}`, () => {
      expect(scenario.summaryBytes).toBeLessThan(scenario.fullBytes);
    });
  }

  it("preserves completed assistant content and excludes summary-noise rows after compaction", async () => {
    const harness = await createTestAppHarness();
    harnesses.push(harness);

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

    seedEvent(harness.deps, {
      threadId: thread.id,
      environmentId: environment.id,
      sequence: 1,
      type: "thread/started",
      data: {},
    });

    for (let index = 0; index < 1000; index += 1) {
      seedEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        providerThreadId: "provider-thread-1",
        turnId: "turn-1",
        sequence: index + 2,
        type: "item/agentMessage/delta",
        data: {
          itemId: "msg-1",
          delta: index === 0 ? "Final" : " chunk",
        },
      });
    }

    seedEvent(harness.deps, {
      threadId: thread.id,
      environmentId: environment.id,
      providerThreadId: "provider-thread-1",
      turnId: "turn-1",
      sequence: 1002,
      type: "item/completed",
      data: {
        item: {
          id: "msg-1",
          type: "agentMessage",
          text: "Final answer",
        },
      },
    });
    seedEvent(harness.deps, {
      threadId: thread.id,
      environmentId: environment.id,
      providerThreadId: "provider-thread-1",
      turnId: "turn-1",
      sequence: 1003,
      type: "thread/tokenUsage/updated",
      data: {
        tokenUsage: {
          total: {
            totalTokens: 84,
            inputTokens: 42,
            cachedInputTokens: 0,
            outputTokens: 42,
            reasoningOutputTokens: 0,
          },
          last: {
            totalTokens: 42,
            inputTokens: 0,
            cachedInputTokens: 0,
            outputTokens: 42,
            reasoningOutputTokens: 0,
          },
          modelContextWindow: 200_000,
        },
      },
    });

    const timeline = buildThreadTimeline(harness.db, thread, {});

    expect(timeline.rows).toHaveLength(1);
    expect(timeline.rows[0]).toMatchObject({
      kind: "message",
      message: {
        kind: "assistant-text",
        text: "Final answer",
        status: "completed",
        sourceSeqStart: 2,
        sourceSeqEnd: 1002,
      },
    });
    expect(timeline.contextWindowUsage).toEqual({
      totalTokens: 42,
      modelContextWindow: 200_000,
    });
  });

  it("keeps the last non-null modelContextWindow when the newest token-usage row omits it", async () => {
    const harness = await createTestAppHarness();
    harnesses.push(harness);

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

    seedEvent(harness.deps, {
      threadId: thread.id,
      environmentId: environment.id,
      providerThreadId: "provider-thread-1",
      turnId: "turn-1",
      sequence: 1,
      type: "thread/tokenUsage/updated",
      data: {
        tokenUsage: {
          total: {
            totalTokens: 120,
            inputTokens: 80,
            cachedInputTokens: 0,
            outputTokens: 40,
            reasoningOutputTokens: 0,
          },
          last: {
            totalTokens: 120,
            inputTokens: 80,
            cachedInputTokens: 0,
            outputTokens: 40,
            reasoningOutputTokens: 0,
          },
          modelContextWindow: 200_000,
        },
      },
    });
    seedEvent(harness.deps, {
      threadId: thread.id,
      environmentId: environment.id,
      providerThreadId: "provider-thread-1",
      turnId: "turn-2",
      sequence: 2,
      type: "thread/tokenUsage/updated",
      data: {
        tokenUsage: {
          total: {
            totalTokens: 180,
            inputTokens: 110,
            cachedInputTokens: 0,
            outputTokens: 70,
            reasoningOutputTokens: 0,
          },
          last: {
            totalTokens: 60,
            inputTokens: 30,
            cachedInputTokens: 0,
            outputTokens: 30,
            reasoningOutputTokens: 0,
          },
          modelContextWindow: null,
        },
      },
    });

    const timeline = buildThreadTimeline(harness.db, thread, {});

    expect(timeline.contextWindowUsage).toEqual({
      totalTokens: 60,
      modelContextWindow: 200_000,
    });
  });
});
