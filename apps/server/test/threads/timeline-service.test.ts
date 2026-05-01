import { afterEach, describe, expect, it } from "vitest";
import { threadScope, turnScope } from "@bb/domain";
import type { TimelineRow } from "@bb/server-contract";
import { createTestAppHarness } from "../helpers/test-app.js";
import {
  seedEnvironment,
  seedEvent,
  seedHost,
  seedProjectWithSource,
  seedThread,
} from "../helpers/seed.js";
import { getTimelineBenchmarkScenarios } from "../helpers/timeline-benchmark.js";
import {
  buildThreadTimeline,
  buildTimelineTurnSummaryDetails,
} from "../../src/services/threads/timeline.js";

type TimelineSourceTestRow = Extract<
  TimelineRow,
  { kind: "conversation" | "system" | "work" }
>;

function flattenTimelineSourceRows(
  rows: TimelineRow[],
): TimelineSourceTestRow[] {
  const sourceRows: TimelineSourceTestRow[] = [];

  for (const row of rows) {
    switch (row.kind) {
      case "conversation":
      case "system":
        sourceRows.push(row);
        break;
      case "work":
        sourceRows.push(row);
        if (row.workKind === "delegation") {
          sourceRows.push(...flattenTimelineSourceRows(row.childRows));
        }
        break;
      case "turn":
        if (row.children) {
          sourceRows.push(...flattenTimelineSourceRows(row.children));
        }
        break;
    }
  }

  return sourceRows;
}

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
    it(`compacts ${scenario.id} before serializing the summary payload`, () => {
      expect(scenario.summaryEventCount).toBeLessThan(scenario.eventCount);
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
      providerThreadId: "provider-thread-1",
      scope: turnScope("turn-1"),
      type: "turn/started",
      data: {},
    });

    for (let index = 0; index < 1000; index += 1) {
      seedEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        providerThreadId: "provider-thread-1",
        scope: turnScope("turn-1"),
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
      scope: turnScope("turn-1"),
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
      scope: turnScope("turn-1"),
      sequence: 1003,
      type: "turn/completed",
      data: {
        status: "completed",
      },
    });
    seedEvent(harness.deps, {
      threadId: thread.id,
      environmentId: environment.id,
      providerThreadId: "provider-thread-1",
      scope: turnScope("turn-1"),
      sequence: 1004,
      type: "thread/contextWindowUsage/updated",
      data: {
        contextWindowUsage: {
          usedTokens: 42,
          modelContextWindow: 200_000,
          estimated: false,
        },
      },
    });

    const timeline = buildThreadTimeline(harness.db, thread, {
      isDevelopment: true,
    });

    expect(timeline.rows).toHaveLength(1);
    expect(timeline.rows[0]).toMatchObject({
      kind: "conversation",
      role: "assistant",
      text: "Final answer",
      sourceSeqStart: 2,
      sourceSeqEnd: 1002,
    });
    expect(timeline.contextWindowUsage).toEqual({
      usedTokens: 42,
      modelContextWindow: 200_000,
      estimated: false,
    });
  });

  it("shows provider unhandled rows in development or debug views only", async () => {
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
      scope: threadScope(),
      sequence: 1,
      type: "provider/unhandled",
      data: {
        providerId: "codex",
        rawType: "item/tool/requestUserInput",
        rawEvent: {
          jsonrpc: "2.0",
          method: "item/tool/requestUserInput",
          params: {
            threadId: thread.id,
          },
        },
      },
    });

    expect(
      buildThreadTimeline(harness.db, thread, { isDevelopment: false }).rows,
    ).toEqual([]);

    const developmentTimeline = buildThreadTimeline(harness.db, thread, {
      isDevelopment: true,
    });
    const developmentRows = developmentTimeline.rows.filter(
      (row): row is Extract<TimelineRow, { kind: "system" }> =>
        row.kind === "system",
    );

    expect(developmentRows).toHaveLength(1);
    expect(developmentRows[0]).toMatchObject({
      systemKind: "operation",
      title: "Unhandled Codex event",
    });

    const debugTimeline = buildThreadTimeline(harness.db, thread, {
      isDevelopment: false,
      showAllManagerEvents: true,
    });
    const debugRows = debugTimeline.rows.filter(
      (row): row is Extract<TimelineRow, { kind: "system" }> =>
        row.kind === "system",
    );

    expect(debugRows).toHaveLength(1);
    expect(debugRows[0]).toMatchObject({
      systemKind: "operation",
      title: "Unhandled Codex event",
    });
  });

  it("reports active thinking even when a reasoning block has no visible text yet", async () => {
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
      status: "active",
    });

    seedEvent(harness.deps, {
      createdAt: 100,
      threadId: thread.id,
      environmentId: environment.id,
      providerThreadId: "provider-thread-1",
      scope: turnScope("turn-1"),
      sequence: 1,
      type: "turn/started",
      data: {},
    });
    seedEvent(harness.deps, {
      createdAt: 200,
      threadId: thread.id,
      environmentId: environment.id,
      providerThreadId: "provider-thread-1",
      scope: turnScope("turn-1"),
      sequence: 2,
      type: "item/started",
      data: {
        item: {
          type: "reasoning",
          id: "reasoning-1",
          summary: [],
          content: [],
        },
      },
    });

    const timeline = buildThreadTimeline(harness.db, thread, {
      isDevelopment: true,
    });

    expect(timeline.activeThinking).toMatchObject({
      id: "reasoning-1",
      text: "",
      startedAt: 200,
      updatedAt: 200,
    });
    expect(timeline.rows).toEqual([]);
  });

  it("keeps partial streaming thinking details hidden until a newline boundary", async () => {
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
      status: "active",
    });

    seedEvent(harness.deps, {
      createdAt: 100,
      threadId: thread.id,
      environmentId: environment.id,
      providerThreadId: "provider-thread-1",
      scope: turnScope("turn-1"),
      sequence: 1,
      type: "turn/started",
      data: {},
    });
    seedEvent(harness.deps, {
      createdAt: 250,
      threadId: thread.id,
      environmentId: environment.id,
      providerThreadId: "provider-thread-1",
      scope: turnScope("turn-1"),
      sequence: 2,
      type: "item/reasoning/textDelta",
      data: {
        itemId: "reasoning-1",
        delta: "Looking through the workspace.",
      },
    });

    const timeline = buildThreadTimeline(harness.db, thread, {
      isDevelopment: true,
    });

    expect(timeline.activeThinking).toMatchObject({
      id: "reasoning-1",
      text: "",
      startedAt: 250,
      updatedAt: 250,
    });
    expect(timeline.rows).toEqual([]);
  });

  it("returns newline-complete streaming thinking separately without rendering a timeline reasoning row", async () => {
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
      status: "active",
    });

    seedEvent(harness.deps, {
      createdAt: 100,
      threadId: thread.id,
      environmentId: environment.id,
      providerThreadId: "provider-thread-1",
      scope: turnScope("turn-1"),
      sequence: 1,
      type: "turn/started",
      data: {},
    });
    seedEvent(harness.deps, {
      createdAt: 300,
      threadId: thread.id,
      environmentId: environment.id,
      providerThreadId: "provider-thread-1",
      scope: turnScope("turn-1"),
      sequence: 2,
      type: "item/reasoning/textDelta",
      data: {
        itemId: "reasoning-1",
        delta: "Looking through the workspace.\nTrailing partial",
      },
    });

    const timeline = buildThreadTimeline(harness.db, thread, {
      isDevelopment: true,
    });

    expect(timeline.activeThinking).toMatchObject({
      id: "reasoning-1",
      text: "Looking through the workspace.\n",
      startedAt: 300,
      updatedAt: 300,
    });
    expect(timeline.rows).toEqual([]);
  });

  it("advances active thinking updatedAt when later reasoning deltas arrive", async () => {
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
      status: "active",
    });

    seedEvent(harness.deps, {
      createdAt: 100,
      threadId: thread.id,
      environmentId: environment.id,
      providerThreadId: "provider-thread-1",
      scope: turnScope("turn-1"),
      sequence: 1,
      type: "turn/started",
      data: {},
    });
    seedEvent(harness.deps, {
      createdAt: 150,
      threadId: thread.id,
      environmentId: environment.id,
      providerThreadId: "provider-thread-1",
      scope: turnScope("turn-1"),
      sequence: 2,
      type: "item/started",
      data: {
        item: {
          type: "reasoning",
          id: "reasoning-1",
          summary: [],
          content: [],
        },
      },
    });
    seedEvent(harness.deps, {
      createdAt: 250,
      threadId: thread.id,
      environmentId: environment.id,
      providerThreadId: "provider-thread-1",
      scope: turnScope("turn-1"),
      sequence: 3,
      type: "item/reasoning/textDelta",
      data: {
        itemId: "reasoning-1",
        delta: "Looking through the workspace.",
      },
    });
    seedEvent(harness.deps, {
      createdAt: 400,
      threadId: thread.id,
      environmentId: environment.id,
      providerThreadId: "provider-thread-1",
      scope: turnScope("turn-1"),
      sequence: 4,
      type: "item/reasoning/textDelta",
      data: {
        itemId: "reasoning-1",
        delta: "\nNext step",
      },
    });

    const timeline = buildThreadTimeline(harness.db, thread, {
      isDevelopment: true,
    });

    expect(timeline.activeThinking).toMatchObject({
      id: "reasoning-1",
      text: "Looking through the workspace.\n",
      startedAt: 150,
      updatedAt: 400,
    });
    expect(timeline.activeThinking?.updatedAt).toBeGreaterThan(
      timeline.activeThinking?.startedAt ?? 0,
    );
  });

  it("removes completed thinking from summary rows", async () => {
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
      scope: turnScope("turn-1"),
      sequence: 1,
      type: "turn/started",
      data: {},
    });
    seedEvent(harness.deps, {
      threadId: thread.id,
      environmentId: environment.id,
      providerThreadId: "provider-thread-1",
      scope: turnScope("turn-1"),
      sequence: 2,
      type: "item/reasoning/textDelta",
      data: {
        itemId: "reasoning-1",
        delta: "Thinking through the answer.",
      },
    });
    seedEvent(harness.deps, {
      threadId: thread.id,
      environmentId: environment.id,
      providerThreadId: "provider-thread-1",
      scope: turnScope("turn-1"),
      sequence: 3,
      type: "item/completed",
      data: {
        item: {
          type: "reasoning",
          id: "reasoning-1",
          summary: [],
          content: ["Thinking through the answer."],
        },
      },
    });
    seedEvent(harness.deps, {
      threadId: thread.id,
      environmentId: environment.id,
      providerThreadId: "provider-thread-1",
      scope: turnScope("turn-1"),
      sequence: 4,
      type: "item/completed",
      data: {
        item: {
          type: "agentMessage",
          id: "assistant-1",
          text: "Done.",
        },
      },
    });
    seedEvent(harness.deps, {
      threadId: thread.id,
      environmentId: environment.id,
      providerThreadId: "provider-thread-1",
      scope: turnScope("turn-1"),
      sequence: 5,
      type: "turn/completed",
      data: {
        status: "completed",
      },
    });

    const timeline = buildThreadTimeline(harness.db, thread, {
      isDevelopment: true,
    });

    expect(timeline.activeThinking).toBeNull();
    expect(timeline.rows).toHaveLength(1);
    expect(timeline.rows[0]).toMatchObject({
      kind: "conversation",
      role: "assistant",
      text: "Done.",
    });
  });

  it("clears active thinking when the thread is interrupted before reasoning completes", async () => {
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
      status: "active",
    });

    seedEvent(harness.deps, {
      threadId: thread.id,
      environmentId: environment.id,
      providerThreadId: "provider-thread-1",
      scope: turnScope("turn-1"),
      sequence: 1,
      type: "turn/started",
      data: {},
    });
    seedEvent(harness.deps, {
      threadId: thread.id,
      environmentId: environment.id,
      providerThreadId: "provider-thread-1",
      scope: turnScope("turn-1"),
      sequence: 2,
      type: "item/started",
      data: {
        item: {
          type: "reasoning",
          id: "reasoning-1",
          summary: [],
          content: [],
        },
      },
    });
    seedEvent(harness.deps, {
      threadId: thread.id,
      environmentId: environment.id,
      providerThreadId: "provider-thread-1",
      scope: turnScope("turn-1"),
      sequence: 3,
      type: "item/reasoning/textDelta",
      data: {
        itemId: "reasoning-1",
        delta: "Partial reasoning",
      },
    });
    seedEvent(harness.deps, {
      threadId: thread.id,
      environmentId: environment.id,
      scope: threadScope(),
      sequence: 4,
      type: "system/thread/interrupted",
      data: {
        turnId: "turn-1",
        reason: "manual-stop",
      },
    });

    const timeline = buildThreadTimeline(harness.db, thread, {
      isDevelopment: true,
    });

    expect(timeline.activeThinking).toBeNull();
  });

  it("surfaces active thinking only for active threads", async () => {
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
      status: "active",
    });

    seedEvent(harness.deps, {
      threadId: thread.id,
      environmentId: environment.id,
      providerThreadId: "provider-thread-1",
      scope: turnScope("turn-1"),
      sequence: 1,
      type: "turn/started",
      data: {},
    });
    seedEvent(harness.deps, {
      threadId: thread.id,
      environmentId: environment.id,
      providerThreadId: "provider-thread-1",
      scope: turnScope("turn-1"),
      sequence: 2,
      type: "item/started",
      data: {
        item: {
          type: "reasoning",
          id: "reasoning-1",
          summary: [],
          content: [],
        },
      },
    });

    const activeTimeline = buildThreadTimeline(harness.db, thread, {
      isDevelopment: true,
    });
    const provisioningTimeline = buildThreadTimeline(
      harness.db,
      {
        ...thread,
        status: "provisioning",
      },
      { isDevelopment: true },
    );
    const idleTimeline = buildThreadTimeline(
      harness.db,
      {
        ...thread,
        status: "idle",
      },
      { isDevelopment: true },
    );

    expect(activeTimeline.activeThinking).toMatchObject({
      id: "reasoning-1",
      text: "",
    });
    expect(provisioningTimeline.activeThinking).toBeNull();
    expect(idleTimeline.activeThinking).toBeNull();
  });

  it("does not reopen active thinking on active threads after a reasoning item completes", async () => {
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
      status: "active",
    });

    seedEvent(harness.deps, {
      threadId: thread.id,
      environmentId: environment.id,
      providerThreadId: "provider-thread-1",
      scope: turnScope("turn-1"),
      sequence: 1,
      type: "turn/started",
      data: {},
    });
    seedEvent(harness.deps, {
      threadId: thread.id,
      environmentId: environment.id,
      providerThreadId: "provider-thread-1",
      scope: turnScope("turn-1"),
      sequence: 2,
      type: "item/started",
      data: {
        item: {
          type: "reasoning",
          id: "reasoning-1",
          summary: [],
          content: [],
        },
      },
    });
    seedEvent(harness.deps, {
      threadId: thread.id,
      environmentId: environment.id,
      providerThreadId: "provider-thread-1",
      scope: turnScope("turn-1"),
      sequence: 3,
      type: "item/completed",
      data: {
        item: {
          type: "reasoning",
          id: "reasoning-1",
          summary: ["Final reasoning"],
          content: [],
        },
      },
    });
    seedEvent(harness.deps, {
      threadId: thread.id,
      environmentId: environment.id,
      providerThreadId: "provider-thread-1",
      scope: turnScope("turn-1"),
      sequence: 4,
      type: "item/reasoning/textDelta",
      data: {
        itemId: "reasoning-1",
        delta: " late",
      },
    });

    const timeline = buildThreadTimeline(harness.db, thread, {
      isDevelopment: true,
    });

    expect(timeline.activeThinking).toBeNull();
  });

  it("does not surface active thinking after an interrupted turn receives a fresh late reasoning item", async () => {
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
      status: "active",
    });

    seedEvent(harness.deps, {
      threadId: thread.id,
      environmentId: environment.id,
      providerThreadId: "provider-thread-1",
      scope: turnScope("turn-1"),
      sequence: 1,
      type: "turn/started",
      data: {},
    });
    seedEvent(harness.deps, {
      threadId: thread.id,
      environmentId: environment.id,
      scope: threadScope(),
      sequence: 2,
      type: "system/thread/interrupted",
      data: {
        reason: "manual-stop",
      },
    });
    seedEvent(harness.deps, {
      threadId: thread.id,
      environmentId: environment.id,
      providerThreadId: "provider-thread-1",
      scope: turnScope("turn-1"),
      sequence: 3,
      type: "item/reasoning/textDelta",
      data: {
        itemId: "reasoning-99",
        delta: " late",
      },
    });

    const timeline = buildThreadTimeline(harness.db, thread, {
      isDevelopment: true,
    });

    expect(timeline.activeThinking).toBeNull();
  });

  it("does not attach visible reasoning details from a different open reasoning item", async () => {
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
      status: "active",
    });

    seedEvent(harness.deps, {
      threadId: thread.id,
      environmentId: environment.id,
      providerThreadId: "provider-thread-1",
      scope: turnScope("turn-1"),
      sequence: 1,
      type: "turn/started",
      data: {},
    });
    seedEvent(harness.deps, {
      threadId: thread.id,
      environmentId: environment.id,
      providerThreadId: "provider-thread-1",
      scope: turnScope("turn-1"),
      sequence: 2,
      type: "item/started",
      data: {
        item: {
          type: "reasoning",
          id: "reasoning-1",
          summary: [],
          content: [],
        },
      },
    });
    seedEvent(harness.deps, {
      threadId: thread.id,
      environmentId: environment.id,
      providerThreadId: "provider-thread-1",
      scope: turnScope("turn-1"),
      sequence: 3,
      type: "item/reasoning/textDelta",
      data: {
        itemId: "reasoning-1",
        delta: "Visible reasoning.\nTrailing partial",
      },
    });
    seedEvent(harness.deps, {
      threadId: thread.id,
      environmentId: environment.id,
      providerThreadId: "provider-thread-1",
      scope: turnScope("turn-1"),
      sequence: 4,
      type: "item/started",
      data: {
        item: {
          type: "reasoning",
          id: "reasoning-2",
          summary: [],
          content: [],
        },
      },
    });

    const timeline = buildThreadTimeline(harness.db, thread, {
      isDevelopment: true,
    });

    expect(timeline.activeThinking).toMatchObject({
      id: "reasoning-2",
      text: "",
    });
  });

  it("keeps the last non-null modelContextWindow when the newest context-usage row omits it", async () => {
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
      scope: turnScope("turn-1"),
      sequence: 1,
      type: "thread/contextWindowUsage/updated",
      data: {
        contextWindowUsage: {
          usedTokens: 120,
          modelContextWindow: 200_000,
          estimated: false,
        },
      },
    });
    seedEvent(harness.deps, {
      threadId: thread.id,
      environmentId: environment.id,
      providerThreadId: "provider-thread-1",
      scope: turnScope("turn-2"),
      sequence: 2,
      type: "thread/contextWindowUsage/updated",
      data: {
        contextWindowUsage: {
          usedTokens: 60,
          modelContextWindow: null,
          estimated: true,
        },
      },
    });

    const timeline = buildThreadTimeline(harness.db, thread, {
      isDevelopment: true,
    });

    expect(timeline.contextWindowUsage).toEqual({
      usedTokens: 60,
      modelContextWindow: 200_000,
      estimated: true,
    });
  });

  it("fails loudly when turn summary details cannot match a projected turn-summary range", async () => {
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
      scope: turnScope("turn-1"),
      sequence: 1,
      type: "turn/started",
      data: {},
    });
    seedEvent(harness.deps, {
      threadId: thread.id,
      environmentId: environment.id,
      providerThreadId: "provider-thread-1",
      scope: turnScope("turn-1"),
      sequence: 2,
      type: "item/completed",
      data: {
        item: {
          type: "toolCall",
          id: "tool-1",
          tool: "exec_command",
          arguments: { cmd: "pnpm test" },
          status: "completed",
        },
      },
    });
    seedEvent(harness.deps, {
      threadId: thread.id,
      environmentId: environment.id,
      providerThreadId: "provider-thread-1",
      scope: turnScope("turn-1"),
      sequence: 3,
      type: "item/completed",
      data: {
        item: {
          type: "agentMessage",
          id: "assistant-1",
          text: "Done.",
        },
      },
    });
    seedEvent(harness.deps, {
      threadId: thread.id,
      environmentId: environment.id,
      providerThreadId: "provider-thread-1",
      scope: turnScope("turn-1"),
      sequence: 4,
      type: "turn/completed",
      data: {
        status: "completed",
      },
    });

    expect(() =>
      buildTimelineTurnSummaryDetails(harness.db, thread, {
        isDevelopment: true,
        sourceSeqStart: 1,
        sourceSeqEnd: 5,
      }),
    ).toThrow(/Timeline turn summary details could not match range 1-5/);
  });

  it("matches tool detail ranges whose end depends on the following input-accepted event", async () => {
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
      scope: turnScope("turn-1"),
      sequence: 1,
      type: "turn/started",
      data: {},
    });
    seedEvent(harness.deps, {
      threadId: thread.id,
      environmentId: environment.id,
      providerThreadId: "provider-thread-1",
      scope: turnScope("turn-1"),
      sequence: 2,
      type: "item/completed",
      data: {
        item: {
          type: "toolCall",
          id: "tool-1",
          tool: "exec_command",
          arguments: { cmd: "pnpm test" },
          status: "completed",
        },
      },
    });
    seedEvent(harness.deps, {
      threadId: thread.id,
      environmentId: environment.id,
      providerThreadId: "provider-thread-1",
      scope: turnScope("turn-1"),
      sequence: 3,
      type: "item/completed",
      data: {
        item: {
          type: "agentMessage",
          id: "assistant-1",
          text: "Done.",
        },
      },
    });
    seedEvent(harness.deps, {
      threadId: thread.id,
      environmentId: environment.id,
      providerThreadId: "provider-thread-1",
      scope: turnScope("turn-1"),
      sequence: 4,
      type: "turn/completed",
      data: {
        status: "completed",
      },
    });
    seedEvent(harness.deps, {
      threadId: thread.id,
      environmentId: environment.id,
      sequence: 5,
      type: "client/turn/requested",
      scope: threadScope(),
      data: {
        direction: "outbound",
        source: "tell",
        initiator: "user",
        request: { method: "turn/start", params: {} },
        input: [{ type: "text", text: "Follow-up" }],
        target: { kind: "new-turn" },
        execution: {
          model: "gpt-5",
          serviceTier: "default",
          reasoningLevel: "medium",
          permissionMode: "full",
          source: "client/turn/requested",
        },
      },
    });
    seedEvent(harness.deps, {
      threadId: thread.id,
      environmentId: environment.id,
      providerThreadId: "provider-thread-1",
      scope: turnScope("turn-1"),
      sequence: 8,
      type: "turn/input/accepted",
      data: {
        clientRequestSequence: 5,
      },
    });

    const timeline = buildThreadTimeline(harness.db, thread, {
      isDevelopment: true,
    });
    const turnSummary = timeline.rows.find((row) => row.kind === "turn");

    expect(turnSummary).toMatchObject({
      sourceSeqStart: 1,
      sourceSeqEnd: 5,
    });

    const details = buildTimelineTurnSummaryDetails(harness.db, thread, {
      isDevelopment: true,
      sourceSeqStart: 1,
      sourceSeqEnd: 5,
    });
    const detailRows = flattenTimelineSourceRows(details.rows);
    const toolRows = detailRows.filter(
      (row): row is Extract<TimelineRow, { kind: "work"; workKind: "tool" }> =>
        row.kind === "work" && row.workKind === "tool",
    );

    expect(toolRows).toHaveLength(1);
    expect(toolRows[0]).toMatchObject({
      kind: "work",
      workKind: "tool",
      sourceSeqStart: 2,
      sourceSeqEnd: 2,
    });
  });

  it("finds matching input-accepted events without a widening lookahead cap", async () => {
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
      scope: turnScope("turn-1"),
      sequence: 1,
      type: "turn/started",
      data: {},
    });
    seedEvent(harness.deps, {
      threadId: thread.id,
      environmentId: environment.id,
      providerThreadId: "provider-thread-1",
      scope: turnScope("turn-1"),
      sequence: 2,
      type: "item/completed",
      data: {
        item: {
          type: "toolCall",
          id: "tool-1",
          tool: "exec_command",
          arguments: { cmd: "pnpm test" },
          status: "completed",
        },
      },
    });
    seedEvent(harness.deps, {
      threadId: thread.id,
      environmentId: environment.id,
      providerThreadId: "provider-thread-1",
      scope: turnScope("turn-1"),
      sequence: 3,
      type: "item/completed",
      data: {
        item: {
          type: "agentMessage",
          id: "assistant-1",
          text: "Done.",
        },
      },
    });
    seedEvent(harness.deps, {
      threadId: thread.id,
      environmentId: environment.id,
      providerThreadId: "provider-thread-1",
      scope: turnScope("turn-1"),
      sequence: 4,
      type: "turn/completed",
      data: {
        status: "completed",
      },
    });
    seedEvent(harness.deps, {
      threadId: thread.id,
      environmentId: environment.id,
      sequence: 5,
      type: "client/turn/requested",
      scope: threadScope(),
      data: {
        direction: "outbound",
        source: "tell",
        initiator: "user",
        request: { method: "turn/start", params: {} },
        input: [{ type: "text", text: "Follow-up" }],
        target: { kind: "new-turn" },
        execution: {
          model: "gpt-5",
          serviceTier: "default",
          reasoningLevel: "medium",
          permissionMode: "full",
          source: "client/turn/requested",
        },
      },
    });

    for (let sequence = 6; sequence < 136; sequence += 1) {
      seedEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        sequence,
        type: "system/thread-provisioning",
        scope: threadScope(),
        data: {
          provisioningId: `tpv-${sequence}`,
          status: "completed",
          environmentId: environment.id,
          entries: [],
        },
      });
    }

    seedEvent(harness.deps, {
      threadId: thread.id,
      environmentId: environment.id,
      providerThreadId: "provider-thread-1",
      scope: turnScope("turn-1"),
      sequence: 136,
      type: "turn/input/accepted",
      data: {
        clientRequestSequence: 5,
      },
    });

    const timeline = buildThreadTimeline(harness.db, thread, {
      isDevelopment: true,
    });
    const turnSummary = timeline.rows.find((row) => row.kind === "turn");

    expect(turnSummary).toMatchObject({
      sourceSeqStart: 1,
      sourceSeqEnd: 5,
    });

    const details = buildTimelineTurnSummaryDetails(harness.db, thread, {
      isDevelopment: true,
      sourceSeqStart: 1,
      sourceSeqEnd: 5,
    });

    const detailRows = flattenTimelineSourceRows(details.rows);
    const toolRows = detailRows.filter(
      (row): row is Extract<TimelineRow, { kind: "work"; workKind: "tool" }> =>
        row.kind === "work" && row.workKind === "tool",
    );

    expect(toolRows).toEqual([
      expect.objectContaining({
        kind: "work",
        workKind: "tool",
        sourceSeqStart: 2,
        sourceSeqEnd: 2,
      }),
    ]);
  });

  it("returns flattened turn-summary details rows when the selected range has no turn summaries", async () => {
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
      scope: turnScope("turn-1"),
      sequence: 1,
      type: "turn/started",
      data: {},
    });
    seedEvent(harness.deps, {
      threadId: thread.id,
      environmentId: environment.id,
      providerThreadId: "provider-thread-1",
      scope: turnScope("turn-1"),
      sequence: 2,
      type: "item/completed",
      data: {
        item: {
          type: "agentMessage",
          id: "assistant-1",
          text: "Nothing to expand.",
        },
      },
    });
    seedEvent(harness.deps, {
      threadId: thread.id,
      environmentId: environment.id,
      providerThreadId: "provider-thread-1",
      scope: turnScope("turn-1"),
      sequence: 3,
      type: "turn/completed",
      data: {
        status: "completed",
      },
    });

    const details = buildTimelineTurnSummaryDetails(harness.db, thread, {
      isDevelopment: true,
      sourceSeqStart: 1,
      sourceSeqEnd: 3,
    });
    const detailRows = flattenTimelineSourceRows(details.rows);

    expect(detailRows).toHaveLength(1);
    expect(detailRows[0]?.kind).toBe("conversation");
    if (detailRows[0]?.kind === "conversation") {
      expect(detailRows[0].text).toBe("Nothing to expand.");
    }
  });

  it("applies provider unhandled gating to turn-summary details", async () => {
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
      scope: turnScope("turn-1"),
      sequence: 1,
      type: "turn/started",
      data: {},
    });
    seedEvent(harness.deps, {
      threadId: thread.id,
      environmentId: environment.id,
      providerThreadId: "provider-thread-1",
      scope: turnScope("turn-1"),
      sequence: 2,
      type: "provider/unhandled",
      data: {
        providerId: "codex",
        rawType: "item/tool/requestUserInput",
        rawEvent: {
          jsonrpc: "2.0",
          method: "item/tool/requestUserInput",
          params: {
            threadId: thread.id,
            turnId: "turn-1",
          },
        },
      },
    });
    seedEvent(harness.deps, {
      threadId: thread.id,
      environmentId: environment.id,
      providerThreadId: "provider-thread-1",
      scope: turnScope("turn-1"),
      sequence: 3,
      type: "turn/completed",
      data: {
        status: "completed",
      },
    });

    expect(
      buildTimelineTurnSummaryDetails(harness.db, thread, {
        isDevelopment: false,
        sourceSeqStart: 1,
        sourceSeqEnd: 3,
      }).rows,
    ).toEqual([]);

    const developmentDetails = buildTimelineTurnSummaryDetails(
      harness.db,
      thread,
      {
        isDevelopment: true,
        sourceSeqStart: 1,
        sourceSeqEnd: 3,
      },
    );
    const debugDetails = buildTimelineTurnSummaryDetails(harness.db, thread, {
      isDevelopment: false,
      showAllManagerEvents: true,
      sourceSeqStart: 1,
      sourceSeqEnd: 3,
    });
    const developmentRows = flattenTimelineSourceRows(developmentDetails.rows);
    const debugRows = flattenTimelineSourceRows(debugDetails.rows);

    expect(developmentRows).toHaveLength(1);
    expect(developmentRows[0]).toMatchObject({
      kind: "system",
      systemKind: "operation",
      title: "Unhandled Codex event",
    });
    expect(debugRows).toHaveLength(1);
    expect(debugRows[0]).toMatchObject({
      kind: "system",
      systemKind: "operation",
      title: "Unhandled Codex event",
    });
  });

  it("filters manager thread timeline to user messages, message_user output, and operations", async () => {
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
      type: "manager",
    });

    // System-initiated welcome message (should be hidden)
    seedEvent(harness.deps, {
      threadId: thread.id,
      environmentId: environment.id,
      sequence: 1,
      type: "client/turn/requested",
      scope: threadScope(),
      data: {
        direction: "outbound",
        source: "spawn",
        initiator: "system",
        input: [{ type: "text", text: "[bb system] Welcome!" }],
        target: { kind: "thread-start" },
        request: { method: "thread/start", params: {} },
        execution: {
          model: "gpt-5",
          serviceTier: "default",
          reasoningLevel: "medium",
          permissionMode: "full",
          source: "client/turn/requested",
        },
      },
    });

    // Provisioning operation (should be visible)
    seedEvent(harness.deps, {
      threadId: thread.id,
      environmentId: environment.id,
      sequence: 2,
      type: "system/thread-provisioning",
      scope: threadScope(),
      data: {
        provisioningId: "tpv-1",
        status: "completed",
        environmentId: environment.id,
        entries: [
          {
            type: "step",
            key: "workspace-path",
            text: "Using workspace: /tmp/test",
            status: "completed",
          },
        ],
      },
    });

    seedEvent(harness.deps, {
      threadId: thread.id,
      environmentId: environment.id,
      providerThreadId: "provider-1",
      scope: turnScope("turn-1"),
      sequence: 3,
      type: "turn/started",
      data: {},
    });

    // Internal assistant text (should be hidden)
    seedEvent(harness.deps, {
      threadId: thread.id,
      environmentId: environment.id,
      providerThreadId: "provider-1",
      scope: turnScope("turn-1"),
      sequence: 4,
      type: "item/completed",
      data: {
        item: {
          id: "msg-1",
          type: "agentMessage",
          text: "internal reasoning",
        },
      },
    });

    // Internal tool call (should be hidden)
    seedEvent(harness.deps, {
      threadId: thread.id,
      environmentId: environment.id,
      providerThreadId: "provider-1",
      scope: turnScope("turn-1"),
      sequence: 5,
      type: "item/completed",
      data: {
        item: {
          id: "tool-1",
          type: "toolCall",
          tool: "ToolSearch",
          status: "completed",
          result: "found something",
        },
      },
    });

    // message_user delivery (should be visible)
    seedEvent(harness.deps, {
      threadId: thread.id,
      environmentId: environment.id,
      sequence: 6,
      type: "system/manager/user_message",
      scope: threadScope(),
      data: {
        text: "Hello from manager",
        toolCallId: "tool-2",
        turnId: "turn-1",
      },
    });

    seedEvent(harness.deps, {
      threadId: thread.id,
      environmentId: environment.id,
      providerThreadId: "provider-1",
      scope: turnScope("turn-1"),
      sequence: 7,
      type: "turn/completed",
      data: {
        status: "completed",
      },
    });

    // User sends a follow-up message (should be visible)
    seedEvent(harness.deps, {
      threadId: thread.id,
      environmentId: environment.id,
      sequence: 8,
      type: "client/turn/requested",
      scope: threadScope(),
      data: {
        direction: "outbound",
        source: "tell",
        initiator: "user",
        input: [{ type: "text", text: "Thanks, do the thing" }],
        target: { kind: "new-turn" },
        request: { method: "turn/start", params: {} },
        execution: {
          model: "gpt-5",
          serviceTier: "default",
          reasoningLevel: "medium",
          permissionMode: "full",
          source: "client/turn/requested",
        },
      },
    });

    // Default view — should show only operation, message_user, and user message
    const defaultTimeline = buildThreadTimeline(harness.db, thread, {
      isDevelopment: true,
    });
    const defaultKinds = defaultTimeline.rows.map((row) =>
      row.kind === "conversation" ? row.role : row.kind,
    );
    expect(defaultKinds).toEqual(["system", "assistant", "user"]);

    // Verify the assistant-text is the message_user output
    const assistantRow = defaultTimeline.rows.find(
      (row) => row.kind === "conversation" && row.role === "assistant",
    );
    expect(assistantRow).toBeDefined();
    if (assistantRow?.kind === "conversation") {
      expect(assistantRow.text).toBe("Hello from manager");
    }

    // Show all events — should show everything
    const debugTimeline = buildThreadTimeline(harness.db, thread, {
      isDevelopment: false,
      showAllManagerEvents: true,
    });
    expect(debugTimeline.rows.length).toBeGreaterThan(
      defaultTimeline.rows.length,
    );
  });

  it("keeps manager-visible messages that would otherwise be buried in turn summaries", async () => {
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
      type: "manager",
    });

    seedEvent(harness.deps, {
      threadId: thread.id,
      environmentId: environment.id,
      providerThreadId: "provider-1",
      scope: turnScope("turn-1"),
      sequence: 1,
      type: "turn/started",
      data: {},
    });
    seedEvent(harness.deps, {
      threadId: thread.id,
      environmentId: environment.id,
      providerThreadId: "provider-1",
      scope: turnScope("turn-1"),
      sequence: 2,
      type: "item/started",
      data: {
        item: {
          id: "compact-1",
          type: "contextCompaction",
        },
      },
    });
    seedEvent(harness.deps, {
      threadId: thread.id,
      environmentId: environment.id,
      providerThreadId: "provider-1",
      scope: turnScope("turn-1"),
      sequence: 3,
      type: "item/completed",
      data: {
        item: {
          id: "compact-1",
          type: "contextCompaction",
        },
      },
    });
    seedEvent(harness.deps, {
      threadId: thread.id,
      environmentId: environment.id,
      sequence: 4,
      type: "system/manager/user_message",
      scope: threadScope(),
      data: {
        text: "Visible manager update",
        toolCallId: "tool-1",
        turnId: "turn-1",
      },
    });
    seedEvent(harness.deps, {
      threadId: thread.id,
      environmentId: environment.id,
      providerThreadId: "provider-1",
      scope: turnScope("turn-1"),
      sequence: 5,
      type: "item/completed",
      data: {
        item: {
          id: "internal-final",
          type: "agentMessage",
          text: "internal final response",
        },
      },
    });
    seedEvent(harness.deps, {
      threadId: thread.id,
      environmentId: environment.id,
      providerThreadId: "provider-1",
      scope: turnScope("turn-1"),
      sequence: 6,
      type: "turn/completed",
      data: {
        status: "completed",
      },
    });

    const timeline = buildThreadTimeline(harness.db, thread, {
      isDevelopment: true,
    });
    const rows = flattenTimelineSourceRows(timeline.rows);

    expect(timeline.rows).toHaveLength(2);
    expect(rows.map((row) => row.kind)).toEqual(["system", "conversation"]);
    expect(rows[0]?.kind).toBe("system");
    if (rows[0]?.kind === "system") {
      expect(rows[0].systemKind).toBe("operation");
      expect(rows[0].title).toBe("Context compacted");
    }
    expect(rows[1]?.kind).toBe("conversation");
    if (rows[1]?.kind === "conversation") {
      expect(rows[1].text).toBe("Visible manager update");
    }
  });
});
