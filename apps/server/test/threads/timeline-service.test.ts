import { afterEach, describe, expect, it } from "vitest";
import type { TimelineRow } from "@bb/domain";
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
  buildTimelineToolDetails,
} from "../../src/services/threads/timeline.js";

type TimelineMessageRow = Extract<TimelineRow, { kind: "message" }>;

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
      turnId: "turn-1",
      type: "turn/started",
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
      type: "turn/completed",
      data: {
        status: "completed",
      },
    });
    seedEvent(harness.deps, {
      threadId: thread.id,
      environmentId: environment.id,
      providerThreadId: "provider-thread-1",
      turnId: "turn-1",
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
      usedTokens: 42,
      modelContextWindow: 200_000,
      estimated: false,
    });
  });

  it("returns streaming thinking separately without rendering a timeline reasoning row", async () => {
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
      turnId: "turn-1",
      sequence: 1,
      type: "turn/started",
      data: {},
    });
    seedEvent(harness.deps, {
      threadId: thread.id,
      environmentId: environment.id,
      providerThreadId: "provider-thread-1",
      turnId: "turn-1",
      sequence: 2,
      type: "item/reasoning/textDelta",
      data: {
        itemId: "reasoning-1",
        delta: "Looking through the workspace.",
      },
    });

    const timeline = buildThreadTimeline(harness.db, thread, {});

    expect(timeline.activeThinking).toMatchObject({
      text: "Looking through the workspace.",
      startedAt: expect.any(Number),
      updatedAt: expect.any(Number),
    });
    expect(timeline.rows).toEqual([]);
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
      turnId: "turn-1",
      sequence: 1,
      type: "turn/started",
      data: {},
    });
    seedEvent(harness.deps, {
      threadId: thread.id,
      environmentId: environment.id,
      providerThreadId: "provider-thread-1",
      turnId: "turn-1",
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
      turnId: "turn-1",
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
      turnId: "turn-1",
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
      turnId: "turn-1",
      sequence: 5,
      type: "turn/completed",
      data: {
        status: "completed",
      },
    });

    const timeline = buildThreadTimeline(harness.db, thread, {});

    expect(timeline.activeThinking).toBeNull();
    expect(timeline.rows).toHaveLength(1);
    expect(timeline.rows[0]).toMatchObject({
      kind: "message",
      message: {
        kind: "assistant-text",
        text: "Done.",
      },
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
      turnId: "turn-1",
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
      turnId: "turn-2",
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

    const timeline = buildThreadTimeline(harness.db, thread, {});

    expect(timeline.contextWindowUsage).toEqual({
      usedTokens: 60,
      modelContextWindow: 200_000,
      estimated: true,
    });
  });

  it("fails loudly when tool details cannot match a projected tool-group range", async () => {
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
      type: "turn/started",
      data: {},
    });
    seedEvent(harness.deps, {
      threadId: thread.id,
      environmentId: environment.id,
      providerThreadId: "provider-thread-1",
      turnId: "turn-1",
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
      turnId: "turn-1",
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
      turnId: "turn-1",
      sequence: 4,
      type: "turn/completed",
      data: {
        status: "completed",
      },
    });

    expect(() =>
      buildTimelineToolDetails(harness.db, thread, {
        sourceSeqStart: 1,
        sourceSeqEnd: 5,
      })
    ).toThrow(/could not match tool group range 1-5/);
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
      turnId: "turn-1",
      sequence: 1,
      type: "turn/started",
      data: {},
    });
    seedEvent(harness.deps, {
      threadId: thread.id,
      environmentId: environment.id,
      providerThreadId: "provider-thread-1",
      turnId: "turn-1",
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
      turnId: "turn-1",
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
      turnId: "turn-1",
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
      turnId: "turn-1",
      sequence: 8,
      type: "turn/input/accepted",
      data: {
        clientRequestSequence: 5,
      },
    });

    const timeline = buildThreadTimeline(harness.db, thread, {});
    const toolGroup = timeline.rows.find((row) => row.kind === "tool-group");

    expect(toolGroup).toMatchObject({
      sourceSeqStart: 1,
      sourceSeqEnd: 5,
    });

    const details = buildTimelineToolDetails(harness.db, thread, {
      sourceSeqStart: 1,
      sourceSeqEnd: 5,
    });

    expect(details.messages).toHaveLength(1);
    expect(details.messages[0]).toMatchObject({
      kind: "tool-call",
      sourceSeqStart: 2,
      sourceSeqEnd: 2,
    });
  });

  it("returns flattened tool details when the selected range has no tool groups", async () => {
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
      type: "turn/started",
      data: {},
    });
    seedEvent(harness.deps, {
      threadId: thread.id,
      environmentId: environment.id,
      providerThreadId: "provider-thread-1",
      turnId: "turn-1",
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
      turnId: "turn-1",
      sequence: 3,
      type: "turn/completed",
      data: {
        status: "completed",
      },
    });

    const details = buildTimelineToolDetails(harness.db, thread, {
      sourceSeqStart: 1,
      sourceSeqEnd: 3,
    });

    expect(details.messages).toHaveLength(1);
    expect(details.messages[0]?.kind).toBe("assistant-text");
    if (details.messages[0]?.kind === "assistant-text") {
      expect(details.messages[0].text).toBe("Nothing to expand.");
    }
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
      data: {
        status: "completed",
        environmentId: environment.id,
        entries: [
          { type: "step", key: "workspace-path", text: "Using workspace: /tmp/test", status: "completed" },
        ],
      },
    });

    seedEvent(harness.deps, {
      threadId: thread.id,
      environmentId: environment.id,
      providerThreadId: "provider-1",
      turnId: "turn-1",
      sequence: 3,
      type: "turn/started",
      data: {},
    });

    // Internal assistant text (should be hidden)
    seedEvent(harness.deps, {
      threadId: thread.id,
      environmentId: environment.id,
      providerThreadId: "provider-1",
      turnId: "turn-1",
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
      turnId: "turn-1",
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
      turnId: "turn-1",
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
    const defaultTimeline = buildThreadTimeline(harness.db, thread, {});
    const defaultKinds = defaultTimeline.rows.map((row) =>
      row.kind === "message" ? row.message.kind : row.kind,
    );
    expect(defaultKinds).toEqual(["operation", "assistant-text", "user"]);

    // Verify the assistant-text is the message_user output
    const assistantRow = defaultTimeline.rows.find(
      (row) => row.kind === "message" && row.message.kind === "assistant-text",
    );
    expect(assistantRow).toBeDefined();
    if (assistantRow?.kind === "message" && assistantRow.message.kind === "assistant-text") {
      expect(assistantRow.message.text).toBe("Hello from manager");
      expect(assistantRow.message.isManagerUserMessage).toBe(true);
    }

    // Show all events — should show everything
    const debugTimeline = buildThreadTimeline(harness.db, thread, {
      showAllManagerEvents: true,
    });
    expect(debugTimeline.rows.length).toBeGreaterThan(defaultTimeline.rows.length);
  });

  it("keeps manager-visible messages that would otherwise be buried in turn tool groups", async () => {
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
      turnId: "turn-1",
      sequence: 1,
      type: "turn/started",
      data: {},
    });
    seedEvent(harness.deps, {
      threadId: thread.id,
      environmentId: environment.id,
      providerThreadId: "provider-1",
      turnId: "turn-1",
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
      turnId: "turn-1",
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
      turnId: "turn-1",
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
      turnId: "turn-1",
      sequence: 6,
      type: "turn/completed",
      data: {
        status: "completed",
      },
    });

    const timeline = buildThreadTimeline(harness.db, thread, {});
    const rows = timeline.rows.filter(
      (row): row is TimelineMessageRow => row.kind === "message",
    );

    expect(timeline.rows).toHaveLength(2);
    expect(rows.map((row) => row.message.kind)).toEqual([
      "operation",
      "assistant-text",
    ]);
    expect(rows[0]?.message.kind).toBe("operation");
    if (rows[0]?.message.kind === "operation") {
      expect(rows[0].message.opType).toBe("compaction");
      expect(rows[0].message.title).toBe("Context compacted");
    }
    expect(rows[1]?.message.kind).toBe("assistant-text");
    if (rows[1]?.message.kind === "assistant-text") {
      expect(rows[1].message.text).toBe("Visible manager update");
      expect(rows[1].message.isManagerUserMessage).toBe(true);
    }
  });
});
