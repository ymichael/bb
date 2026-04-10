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
      type: "client/thread/start",
      data: {
        direction: "outbound",
        source: "spawn",
        initiator: "system",
        input: [{ type: "text", text: "[bb system] Welcome!" }],
        request: { method: "thread/start", params: {} },
        execution: {
          model: "gpt-5",
          serviceTier: "default",
          reasoningLevel: "medium",
          sandboxMode: "danger-full-access",
          source: "client/thread/start",
        },
      },
    });

    // Provisioning operation (should be visible)
    seedEvent(harness.deps, {
      threadId: thread.id,
      environmentId: environment.id,
      sequence: 2,
      type: "system/provisioning",
      data: {
        status: "completed",
        environmentId: environment.id,
        entries: [
          { type: "step", key: "cwd", text: "cwd: /tmp/test", status: "completed" },
        ],
      },
    });

    // Internal assistant text (should be hidden)
    seedEvent(harness.deps, {
      threadId: thread.id,
      environmentId: environment.id,
      providerThreadId: "provider-1",
      turnId: "turn-1",
      sequence: 3,
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
      sequence: 4,
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
      sequence: 5,
      type: "system/manager/user_message",
      data: {
        text: "Hello from manager",
        toolCallId: "tool-2",
        turnId: "turn-1",
      },
    });

    // User sends a follow-up message (should be visible)
    seedEvent(harness.deps, {
      threadId: thread.id,
      environmentId: environment.id,
      sequence: 6,
      type: "client/turn/requested",
      data: {
        direction: "outbound",
        source: "tell",
        initiator: "user",
        input: [{ type: "text", text: "Thanks, do the thing" }],
        request: { method: "turn/start", params: {} },
        execution: {
          model: "gpt-5",
          serviceTier: "default",
          reasoningLevel: "medium",
          sandboxMode: "danger-full-access",
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
});
