import { describe, expect, it } from "vitest";
import {
  createTimelineEventFactory,
  messageKinds,
  renderTimelineFixture,
} from "./timeline-test-harness.js";
import type { TimelineEventFactory } from "./timeline-test-harness.js";

function renderIdleTimeline(
  events: ReturnType<TimelineEventFactory[keyof TimelineEventFactory]>[],
) {
  return renderTimelineFixture({
    events,
    projectionOptions: {
      threadStatus: "idle",
      turnMessageDetail: "summary",
    },
  });
}

function renderActiveTimeline(
  events: ReturnType<TimelineEventFactory[keyof TimelineEventFactory]>[],
) {
  return renderTimelineFixture({
    events,
    projectionOptions: {
      threadStatus: "active",
      turnMessageDetail: "summary",
    },
  });
}

describe("timeline CLI rendering snapshots", () => {
  it("shows an unacknowledged active-turn steer from the client request", () => {
    const event = createTimelineEventFactory({ threadId: "thread-1" });
    const timeline = renderIdleTimeline([
      event.turnStarted(),
      event.toolCallCompleted({
        itemId: "tool-before-steer",
        arguments: { cmd: "pnpm test" },
      }),
      event.clientTurnRequested({
        target: { kind: "auto", expectedTurnId: "turn-1" },
        text: "Please account for the restart",
      }),
      event.toolCallCompleted({
        itemId: "tool-after-steer",
        arguments: { cmd: "sqlite3 ~/.bb-dev/bb.db '.tables'" },
      }),
      event.assistantCompleted({ itemId: "assistant-1", text: "Done." }),
      event.turnCompleted(),
    ]);

    expect(messageKinds(timeline.messages)).toEqual([
      "tool-call",
      "user",
      "tool-call",
      "assistant-text",
    ]);
    const steerMessage = timeline.messages.find(
      (message) => message.kind === "user",
    );
    expect(steerMessage?.sourceSeqStart).toBe(3);
    expect(timeline.text).toMatchInlineSnapshot(`
      "── Ran 1 command ───────────────────────────────────────────
        ── Tool Call: exec_command ─────────────────────────────────
          [completed] exec_command { cmd: pnpm test }

      ── User ────────────────────────────────────────────────────
      Please account for the restart

      ── Worked on 1 item ────────────────────────────────────────
        ── Ran 1 command ───────────────────────────────────────────
          ── Tool Call: exec_command ─────────────────────────────────
            [completed] exec_command { cmd: sqlite3 ~/.bb-dev/bb.db '.tables' }

      ── Assistant ───────────────────────────────────────────────
      Done."
    `);
  });

  it("uses active-turn input acceptance only as request correlation", () => {
    const event = createTimelineEventFactory({ threadId: "thread-1" });
    const timeline = renderIdleTimeline([
      event.turnStarted(),
      event.toolCallCompleted({
        itemId: "tool-before-steer",
        arguments: { cmd: "pnpm test" },
      }),
      event.clientTurnRequested({
        target: { kind: "auto", expectedTurnId: "turn-1" },
        text: "Please account for the restart",
      }),
      event.inputAccepted({
        clientRequestSequence: 3,
      }),
      event.toolCallCompleted({
        itemId: "tool-after-steer",
        arguments: { cmd: "sqlite3 ~/.bb-dev/bb.db '.tables'" },
      }),
      event.assistantCompleted({ itemId: "assistant-1", text: "Done." }),
      event.turnCompleted(),
    ]);

    expect(messageKinds(timeline.messages)).toEqual([
      "tool-call",
      "user",
      "tool-call",
      "assistant-text",
    ]);
    const steerMessage = timeline.messages.find(
      (message) => message.kind === "user",
    );
    expect(steerMessage?.sourceSeqStart).toBe(3);
    expect(timeline.text).toMatchInlineSnapshot(`
      "── Ran 1 command ───────────────────────────────────────────
        ── Tool Call: exec_command ─────────────────────────────────
          [completed] exec_command { cmd: pnpm test }

      ── User ────────────────────────────────────────────────────
      Please account for the restart

      ── Worked on 1 item ────────────────────────────────────────
        ── Ran 1 command ───────────────────────────────────────────
          ── Tool Call: exec_command ─────────────────────────────────
            [completed] exec_command { cmd: sqlite3 ~/.bb-dev/bb.db '.tables' }

      ── Assistant ───────────────────────────────────────────────
      Done."
    `);
  });

  it("shows provisioning failure as user input, operation, and error", () => {
    const event = createTimelineEventFactory({ threadId: "thread-1" });
    const timeline = renderTimelineFixture({
      events: [
        event.clientTurnRequested({
          requestMethod: "thread/start",
          source: "spawn",
          target: { kind: "thread-start" },
          text: "Start the failing workspace",
        }),
        event.threadProvisioning({
          status: "active",
          entries: [
            {
              type: "step",
              key: "setup",
              text: "Running setup",
              status: "started",
            },
          ],
        }),
        event.threadProvisioning({
          status: "failed",
          entries: [
            {
              type: "output",
              key: "setup-output",
              text: "pnpm install failed",
              startedAt: 3,
            },
          ],
        }),
        event.systemError({
          code: "thread_provisioning_failed",
          message: "Provisioning thread failed",
          detail: "pnpm install failed",
        }),
      ],
      projectionOptions: {
        threadStatus: "error",
        turnMessageDetail: "summary",
      },
    });

    expect(messageKinds(timeline.messages)).toEqual([
      "user",
      "operation",
      "error",
    ]);
    expect(timeline.text).toMatchInlineSnapshot(`
      "── User ────────────────────────────────────────────────────
      Start the failing workspace

      ── Operation: Provisioning thread failed ───────────────────
        [failed]

      ── Error ───────────────────────────────────────────────────
        Provisioning thread failed - pnpm install failed"
    `);
  });

  it("shows compacted tool work before terminal assistant output", () => {
    const event = createTimelineEventFactory({ threadId: "thread-1" });
    const timeline = renderIdleTimeline([
      event.turnStarted(),
      event.commandCompleted({
        itemId: "call-1",
        command: "/bin/zsh -lc 'rg TODO packages/core-ui'",
        aggregatedOutput: "packages/core-ui/src/a.ts:10: TODO\n",
        exitCode: 0,
      }),
      event.commandCompleted({
        itemId: "call-2",
        command: "/bin/zsh -lc 'pnpm test'",
        aggregatedOutput: "Tests passed\n",
        exitCode: 0,
      }),
      event.assistantCompleted({
        itemId: "assistant-1",
        text: "The TODO sweep is clean.",
      }),
      event.turnCompleted(),
    ]);

    expect(timeline.toolGroups).toHaveLength(1);
    expect(timeline.toolGroups[0]?.summaryCount).toBe(2);
    expect(timeline.text).toMatchInlineSnapshot(`
      "── Worked on 2 items ───────────────────────────────────────

      ── Assistant ───────────────────────────────────────────────
      The TODO sweep is clean."
    `);
  });

  it("omits completed reasoning from timeline rows", () => {
    const event = createTimelineEventFactory({ threadId: "thread-1" });
    const timeline = renderIdleTimeline([
      event.turnStarted(),
      event.reasoningDelta({
        itemId: "reasoning-1",
        delta: "I should inspect the nearby files first.",
      }),
      event.reasoningCompleted({
        itemId: "reasoning-1",
        text: "I should inspect the nearby files first.",
      }),
      event.toolCallCompleted({
        itemId: "tool-1",
        arguments: { cmd: "sed -n '1,80p' packages/core-ui/src/index.ts" },
      }),
      event.assistantCompleted({
        itemId: "assistant-1",
        text: "The extension point is the timeline row builder.",
      }),
      event.turnCompleted(),
    ]);

    expect(timeline.toolGroups).toHaveLength(1);
    expect(timeline.toolGroups[0]?.summaryCount).toBe(1);
    expect(timeline.text).not.toContain("Reasoning");
    expect(timeline.text).toMatchInlineSnapshot(`
      "── Worked on 1 item ────────────────────────────────────────

      ── Assistant ───────────────────────────────────────────────
      The extension point is the timeline row builder."
    `);
  });

  it("omits active reasoning from timeline rows", () => {
    const event = createTimelineEventFactory({ threadId: "thread-1" });
    const timeline = renderActiveTimeline([
      event.turnStarted(),
      event.reasoningDelta({
        itemId: "reasoning-1",
        delta: "Checking the current state.",
      }),
    ]);

    expect(timeline.rows).toEqual([]);
    expect(timeline.text).toMatchInlineSnapshot(`""`);
  });

  it("shows tasks, web search, file edit, and assistant output", () => {
    const event = createTimelineEventFactory({ threadId: "thread-1" });
    const timeline = renderActiveTimeline([
      event.turnStarted(),
      event.turnPlanUpdated({
        plan: [
          { step: "Read the route", status: "completed" },
          { step: "Patch the projection", status: "active" },
          { step: "Run focused tests", status: "pending" },
        ],
      }),
      event.webSearchCompleted({
        itemId: "web-1",
        queries: ["React suspense docs"],
        resultText: "Found the React Suspense docs",
      }),
      event.fileChangeCompleted({
        itemId: "edit-1",
        changes: [
          {
            path: "/repo/packages/core-ui/src/timeline.ts",
            kind: "update",
            diff: "@@ -1 +1 @@\n-before\n+after",
          },
        ],
      }),
      event.assistantCompleted({
        itemId: "assistant-1",
        text: "I patched the projection and verified it.",
      }),
    ]);

    expect(messageKinds(timeline.messages)).toEqual([
      "tasks",
      "web-search",
      "file-edit",
      "assistant-text",
    ]);
    expect(timeline.text).toMatchInlineSnapshot(`
      "── Updated tasks ───────────────────────────────────────────
        ☒ Read the route
        ◼ Patch the projection
        □ Run focused tests

      ── Ran 1 web search ────────────────────────────────────────
        ── Searched React suspense docs ────────────────────────────
          [completed] React suspense docs
          Found the React Suspense docs

      ── Edited 1 file ───────────────────────────────────────────
        ── File Edit ───────────────────────────────────────────────
          [completed] /repo/packages/core-ui/src/timeline.ts (update)
          @@ -1 +1 @@
          -before
          +after

      ── Assistant ───────────────────────────────────────────────
      I patched the projection and verified it."
    `);
  });

  it("shows pending approval and denied command states", () => {
    const event = createTimelineEventFactory({ threadId: "thread-1" });
    const timeline = renderActiveTimeline([
      event.permissionGrantLifecycle(),
      event.turnStarted(),
      event.commandCompleted({
        itemId: "call-denied",
        command: "git push",
        approvalStatus: "denied",
      }),
    ]);

    expect(messageKinds(timeline.messages)).toEqual([
      "permission-grant-lifecycle",
      "tool-call",
    ]);
    expect(timeline.text).toMatchInlineSnapshot(`
      "── Waiting for approval to grant Bash ──────────────────────
        [waiting]
        item: item_123
        tool: Bash

      ── Ran 1 command ───────────────────────────────────────────
        ── Tool Call: exec_command ─────────────────────────────────
          [denied] git push"
    `);
  });

  it("shows manager user messages without internal assistant chatter", () => {
    const event = createTimelineEventFactory({
      threadId: "manager-thread-1",
      turnId: "turn-1",
    });
    const timeline = renderTimelineFixture({
      events: [
        event.turnStarted(),
        event.assistantCompleted({
          itemId: "assistant-1",
          text: "internal manager chatter",
        }),
        event.managerUserMessage({ text: "Visible manager update" }),
      ],
      projectionOptions: {
        threadStatus: "idle",
        threadType: "manager",
        turnMessageDetail: "summary",
      },
    });

    expect(messageKinds(timeline.messages)).toEqual(["assistant-text"]);
    expect(timeline.text).toMatchInlineSnapshot(`
      "── Assistant ───────────────────────────────────────────────
      Visible manager update"
    `);
  });

  it("shows reconnect errors compactly", () => {
    const event = createTimelineEventFactory({ threadId: "thread-1" });
    const timeline = renderActiveTimeline([
      event.systemError({
        code: "provider_reconnect",
        message: "Reconnecting... 1/3",
      }),
      event.systemError({
        code: "provider_reconnect",
        message: "Reconnecting... 2/3",
      }),
      event.systemError({
        code: "provider_runtime_error",
        message: "Provider runtime is unavailable",
      }),
    ]);

    expect(messageKinds(timeline.messages)).toEqual([
      "error",
      "error",
      "error",
    ]);
    expect(timeline.rows).toHaveLength(2);
    expect(timeline.text).toMatchInlineSnapshot(`
      "── Error ───────────────────────────────────────────────────
        Reconnecting... 2/3

      ── Error ───────────────────────────────────────────────────
        Provider runtime is unavailable"
    `);
  });
});
