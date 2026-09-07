import { describe, expect, it } from "vitest";
import {
  createTimelineEventFactory,
  messageKinds,
  renderTimelineFixture,
} from "./timeline-test-harness.js";
import { formatThreadTimelineText } from "../src/format-timeline-text.js";
import type { TimelineRow } from "@bb/server-contract";
import type { TimelineEventFactory } from "./timeline-test-harness.js";

type TimelineFixtureEvent = ReturnType<
  TimelineEventFactory[keyof TimelineEventFactory]
>;
type TimelineWebWorkRow = Extract<
  TimelineRow,
  { kind: "work"; workKind: "web-fetch" | "web-search" }
>;

function renderIdleTimeline(events: TimelineFixtureEvent[]) {
  return renderTimelineFixture({
    events,
    projectionOptions: {
      threadStatus: "idle",
      turnMessageDetail: "summary",
    },
  });
}

function renderActiveTimeline(events: TimelineFixtureEvent[]) {
  return renderTimelineFixture({
    events,
    projectionOptions: {
      threadStatus: "active",
      turnMessageDetail: "summary",
    },
  });
}

function renderPrefixSnapshots(events: TimelineFixtureEvent[]) {
  return [1, 3, 5, 8, events.length].map((prefixLength) => {
    const timeline = renderTimelineFixture({
      events: events.slice(0, prefixLength),
      projectionOptions: {
        threadStatus: prefixLength === events.length ? "idle" : "active",
        turnMessageDetail: "summary",
      },
    });
    return {
      prefixLength,
      messageKinds: messageKinds(timeline.messages),
      text: timeline.text,
    };
  });
}

function getNestedRows(row: TimelineRow): readonly TimelineRow[] {
  if (row.kind === "turn") {
    return row.children ?? [];
  }
  if (row.kind === "work" && row.workKind === "delegation") {
    return row.childRows;
  }
  return [];
}

function flattenTimelineRows(rows: readonly TimelineRow[]): TimelineRow[] {
  const flattenedRows: TimelineRow[] = [];
  const visitRows = (currentRows: readonly TimelineRow[]): void => {
    for (const row of currentRows) {
      flattenedRows.push(row);
      visitRows(getNestedRows(row));
    }
  };
  visitRows(rows);
  return flattenedRows;
}

function isTimelineWebWorkRow(row: TimelineRow): row is TimelineWebWorkRow {
  return (
    row.kind === "work" &&
    (row.workKind === "web-search" || row.workKind === "web-fetch")
  );
}

function getOnlyTimelineWebWorkRow(
  rows: readonly TimelineRow[],
): TimelineWebWorkRow {
  const webRows = rows.filter(isTimelineWebWorkRow);
  expect(webRows).toHaveLength(1);
  const row = webRows[0];
  if (!row) {
    throw new Error("Expected one timeline web work row");
  }
  return row;
}

describe("timeline CLI rendering snapshots", () => {
  it("keeps accepted steer rows outside summaries while preserving summary segments", () => {
    const event = createTimelineEventFactory({ threadId: "thread-1" });
    const events: TimelineFixtureEvent[] = [
      event.turnStarted({ createdAt: 0 }),
      event.commandStarted({
        itemId: "cmd-1",
        command: "pnpm test",
        createdAt: 1_000,
      }),
      event.commandCompleted({
        itemId: "cmd-1",
        command: "pnpm test",
        createdAt: 6_000,
      }),
    ];
    const steerRequest = event.clientTurnRequested({
      seq: 4,
      createdAt: 7_000,
      text: "Please keep going",
      target: {
        kind: "steer",
        expectedTurnId: "turn-1",
      },
    });
    events.push(
      steerRequest,
      event.inputAccepted({
        seq: 5,
        createdAt: 8_000,
        clientRequestId: steerRequest.data.requestId,
      }),
      event.commandStarted({
        itemId: "cmd-2",
        command: "pnpm lint",
        createdAt: 10_000,
      }),
      event.commandCompleted({
        itemId: "cmd-2",
        command: "pnpm lint",
        createdAt: 16_000,
      }),
      event.turnCompleted({ createdAt: 17_000 }),
    );
    const timeline = renderIdleTimeline(events);

    expect(timeline.turnRows).toHaveLength(2);
    expect(
      timeline.turnRows.map(({ sourceSeqEnd, sourceSeqStart }) => ({
        sourceSeqEnd,
        sourceSeqStart,
      })),
    ).toEqual([
      { sourceSeqEnd: 3, sourceSeqStart: 2 },
      { sourceSeqEnd: 7, sourceSeqStart: 6 },
    ]);
    expect(timeline.text).toMatchInlineSnapshot(`
      "── Worked for (5s) ─────────────────────────────────────────
        ── Ran pnpm test (5s)
          $ pnpm test

      ── User ────────────────────────────────────────────────────
      Please keep going
      steer

      ── Worked for (6s) ─────────────────────────────────────────
        ── Ran pnpm lint (6s)
          $ pnpm lint"
    `);
  });

  it("shows provider-injected input as a system-initiated steer of its turn", () => {
    const event = createTimelineEventFactory({ threadId: "thread-1" });
    const events: TimelineFixtureEvent[] = [
      event.clientTurnRequested({
        target: { kind: "new-turn" },
        text: "Reply only with ok.",
      }),
      event.turnStarted({ turnId: "turn-1" }),
      event.assistantCompleted({
        itemId: "assistant-1",
        text: "ok",
        turnId: "turn-1",
      }),
      event.turnCompleted({ turnId: "turn-1" }),
      event.turnStarted({ turnId: "turn-2" }),
      event.providerUserMessage({
        text: '<process_event kind="success">Process completed successfully</process_event>',
        turnId: "turn-2",
      }),
      event.assistantCompleted({
        itemId: "assistant-2",
        text: "The sleep process finished.",
        turnId: "turn-2",
      }),
      event.turnCompleted({ turnId: "turn-2" }),
    ];
    const timeline = renderIdleTimeline(events);

    expect(
      timeline.messages.flatMap((message) =>
        message.kind === "user"
          ? [
              {
                initiator: message.initiator,
                scope: message.scope,
                text: message.text,
              },
            ]
          : [],
      ),
    ).toEqual([
      {
        initiator: "user",
        scope: { kind: "thread" },
        text: "Reply only with ok.",
      },
      {
        initiator: "system",
        scope: { kind: "turn", turnId: "turn-2" },
        text: '<process_event kind="success">Process completed successfully</process_event>',
      },
    ]);
    expect(timeline.rows).toContainEqual(
      expect.objectContaining({
        kind: "turn",
        turnId: "turn-2",
        children: [
          expect.objectContaining({
            kind: "conversation",
            role: "user",
            initiator: "system",
            turnRequest: {
              isGrouped: false,
              kind: "steer",
              status: "accepted",
            },
            text: '<process_event kind="success">Process completed successfully</process_event>',
          }),
        ],
      }),
    );
    expect(timeline.text).toMatchInlineSnapshot(`
      "── User ────────────────────────────────────────────────────
      Reply only with ok.

      ── Assistant ───────────────────────────────────────────────
      ok

      ── Worked for (3ms) ────────────────────────────────────────
        ── User
        <process_event kind="success">Process completed successfully</process_event>
        steer

      ── Assistant ───────────────────────────────────────────────
      The sleep process finished."
    `);
  });

  it("snapshots streaming CLI prefixes before the final idle state", () => {
    const event = createTimelineEventFactory({ threadId: "thread-1" });
    const events = [
      event.clientTurnRequested({
        target: { kind: "new-turn" },
        text: "Patch the timeline output",
      }),
      event.turnStarted(),
      event.commandStarted({
        itemId: "cmd-1",
        command: "rg timeline packages/core-ui",
      }),
      event.commandOutputDelta({
        itemId: "cmd-1",
        delta: "packages/core-ui/src/format-timeline-text.ts\n",
      }),
      event.commandCompleted({
        itemId: "cmd-1",
        command: "rg timeline packages/core-ui",
        aggregatedOutput: "packages/core-ui/src/format-timeline-text.ts\n",
        exitCode: 0,
      }),
      event.webSearchStarted({
        itemId: "web-1",
        queries: ["timeline rendering"],
      }),
      event.webSearchCompleted({
        itemId: "web-1",
        queries: ["timeline rendering"],
        resultText: "Found rendering references",
      }),
      event.fileChangeStarted({
        itemId: "edit-1",
        changes: [
          {
            path: "/repo/packages/core-ui/src/format-timeline-text.ts",
            kind: "update",
          },
        ],
      }),
      event.fileChangeCompleted({
        itemId: "edit-1",
        changes: [
          {
            path: "/repo/packages/core-ui/src/format-timeline-text.ts",
            kind: "update",
            diff: "@@ -1 +1 @@\n-before\n+after",
          },
        ],
      }),
      event.assistantDelta({
        itemId: "assistant-1",
        delta: "Updated the timeline output.",
      }),
      event.assistantCompleted({
        itemId: "assistant-1",
        text: "Updated the timeline output.",
      }),
      event.turnCompleted(),
    ];

    expect(renderPrefixSnapshots(events)).toMatchInlineSnapshot(`
      [
        {
          "messageKinds": [
            "user",
          ],
          "prefixLength": 1,
          "text": "── User ────────────────────────────────────────────────────
      Patch the timeline output",
        },
        {
          "messageKinds": [
            "user",
            "command",
          ],
          "prefixLength": 3,
          "text": "── User ────────────────────────────────────────────────────
      Patch the timeline output

      ── Searching for timeline in packages/core-ui ──────────────
        $ rg timeline packages/core-ui",
        },
        {
          "messageKinds": [
            "user",
            "command",
          ],
          "prefixLength": 5,
          "text": "── User ────────────────────────────────────────────────────
      Patch the timeline output

      ── Searched for timeline in packages/core-ui ───────────────
        $ rg timeline packages/core-ui",
        },
        {
          "messageKinds": [
            "user",
            "command",
            "web-search",
            "file-edit",
          ],
          "prefixLength": 8,
          "text": "── User ────────────────────────────────────────────────────
      Patch the timeline output

      ── Searched for timeline in packages/core-ui ───────────────
        $ rg timeline packages/core-ui

      ── Ran web search: timeline rendering ──────────────────────

      ── Editing /repo/packages/core-ui/src/format-timeline-text.ts",
        },
        {
          "messageKinds": [
            "user",
            "command",
            "web-search",
            "file-edit",
            "assistant-text",
          ],
          "prefixLength": 12,
          "text": "── User ────────────────────────────────────────────────────
      Patch the timeline output

      ── Worked for (10ms) ───────────────────────────────────────
        ── Explored 1 search, researched 1 search query, edited 1 file
          ── Searched for timeline in packages/core-ui
          ── Ran web search: timeline rendering
          ── Edited /repo/packages/core-ui/src/format-timeline-text.ts +1 -1
            @@ -1 +1 @@
            -before
            +after

      ── Assistant ───────────────────────────────────────────────
      Updated the timeline output.",
        },
      ]
    `);
  });

  it("renders command output deltas before command completion", () => {
    const event = createTimelineEventFactory({ threadId: "thread-1" });
    const timeline = renderActiveTimeline([
      event.clientTurnRequested({
        target: { kind: "new-turn" },
        text: "Run the focused tests",
      }),
      event.turnStarted(),
      event.commandStarted({
        itemId: "cmd-output",
        command: "pnpm test -- --runInBand",
      }),
      event.commandOutputDelta({
        itemId: "cmd-output",
        delta: "collecting tests\n",
      }),
    ]);
    const commandMessage = timeline.messages.find(
      (message) => message.kind === "command",
    );

    expect(messageKinds(timeline.messages)).toEqual(["user", "command"]);
    expect(commandMessage?.output).toBe("collecting tests\n");
    expect(timeline.text).toContain("Running pnpm test -- --runInBand");
    expect(timeline.text).toContain("$ pnpm test -- --runInBand");
    expect(timeline.text).toContain("collecting tests");
    expect(timeline.text).not.toContain("exit code");
    expect(timeline.text).toMatchInlineSnapshot(`
      "── User ────────────────────────────────────────────────────
      Run the focused tests

      ── Running pnpm test -- --runInBand ────────────────────────
        $ pnpm test -- --runInBand
        collecting tests"
    `);
  });

  it("shows active bundle leaves in minimal output without verbose bodies", () => {
    const event = createTimelineEventFactory({ threadId: "thread-1" });
    const timeline = renderActiveTimeline([
      event.turnStarted(),
      event.commandStarted({
        itemId: "cmd-test",
        command: "pnpm test",
      }),
      event.commandOutputDelta({
        itemId: "cmd-test",
        delta: "collecting tests\n",
      }),
      event.commandStarted({
        itemId: "cmd-lint",
        command: "pnpm lint",
      }),
    ]);

    const minimalText = formatThreadTimelineText(timeline.rows, {
      color: false,
      verbose: false,
    });

    expect(minimalText).not.toContain("collecting tests");
    expect(minimalText).toMatchInlineSnapshot(`
      "── Running 2 commands ──────────────────────────────────────
        ── Running pnpm test
          $ pnpm test
        ── Running pnpm lint
          $ pnpm lint"
    `);
  });

  it("uses shared turn title fallback text in CLI output", () => {
    const text = formatThreadTimelineText(
      [
        {
          id: "thread-1:turn-1:turn",
          threadId: "thread-1",
          turnId: "turn-1",
          sourceSeqStart: 1,
          sourceSeqEnd: 1,
          startedAt: 1,
          createdAt: 1,
          kind: "turn",
          status: "completed",
          summaryCount: 0,
          completedAt: null,
          children: null,
        } satisfies TimelineRow,
      ],
      {
        color: false,
        verbose: false,
      },
    );

    expect(text).toMatchInlineSnapshot(
      `"── Worked ──────────────────────────────────────────────────"`,
    );
  });

  it("shows an unacknowledged active-turn steer from the client request", () => {
    const event = createTimelineEventFactory({ threadId: "thread-1" });
    const timeline = renderActiveTimeline([
      event.turnStarted(),
      event.commandCompleted({
        itemId: "tool-before-steer",
        command: "pnpm test",
      }),
      event.clientTurnRequested({
        target: { kind: "auto", expectedTurnId: "turn-1" },
        text: "Please account for the restart",
      }),
      event.commandCompleted({
        itemId: "tool-after-steer",
        command: "sqlite3 ~/.bb-dev/bb.db '.tables'",
      }),
      event.assistantCompleted({ itemId: "assistant-1", text: "Done." }),
      event.turnCompleted(),
    ]);

    expect(messageKinds(timeline.messages)).toEqual([
      "command",
      "command",
      "assistant-text",
    ]);
    expect(timeline.turnRows).toHaveLength(1);
    expect(timeline.turnRows[0]).toMatchObject({
      kind: "turn",
      status: "completed",
    });
    expect(
      timeline.rows.some(
        (row) => row.kind === "conversation" && row.role === "user",
      ),
    ).toBe(true);
    const pendingSteerRow = timeline.rows.find(
      (
        row,
      ): row is Extract<TimelineRow, { kind: "conversation"; role: "user" }> =>
        row.kind === "conversation" &&
        row.role === "user" &&
        row.turnRequest.status === "pending",
    );
    expect(pendingSteerRow?.sourceSeqStart).toBe(3);
    expect(pendingSteerRow?.turnRequest).toEqual({
      isGrouped: false,
      kind: "steer",
      status: "pending",
    });
    expect(timeline.text).toMatchInlineSnapshot(`
      "── Worked for (5ms) ────────────────────────────────────────
        ── Ran 2 commands
          ── Ran pnpm test
            $ pnpm test
          ── Ran sqlite3 ~/.bb-dev/bb.db '.tables'
            $ sqlite3 ~/.bb-dev/bb.db '.tables'

      ── Assistant ───────────────────────────────────────────────
      Done.

      ── User ────────────────────────────────────────────────────
      Please account for the restart
      steer pending"
    `);
  });

  it("shows a rejected steer as failed instead of pending", () => {
    const event = createTimelineEventFactory({ threadId: "thread-1" });
    const request = event.clientTurnRequested({
      target: { kind: "auto", expectedTurnId: "turn-1" },
      text: "Please account for the restart",
    });
    const timeline = renderIdleTimeline([
      event.turnStarted(),
      request,
      event.clientTurnRejected({ requestId: request.data.requestId }),
      event.turnCompleted({ status: "failed" }),
    ]);

    const rejectedSteerRow = timeline.rows.find(
      (
        row,
      ): row is Extract<TimelineRow, { kind: "conversation"; role: "user" }> =>
        row.kind === "conversation" && row.role === "user",
    );
    expect(rejectedSteerRow?.turnRequest).toEqual({
      isGrouped: false,
      kind: "steer",
      status: "rejected",
    });
    expect(timeline.text).toContain("steer failed");
    expect(timeline.text).not.toContain("steer pending");
  });

  it("closes a legacy unmatched steer after its command failure", () => {
    const event = createTimelineEventFactory({ threadId: "thread-1" });
    const timeline = renderIdleTimeline([
      event.turnStarted(),
      event.clientTurnRequested({
        target: { kind: "auto", expectedTurnId: "turn-1" },
        text: "Late steer",
      }),
      event.systemError({
        code: "thread_command_failed",
        message: "Command turn.submit failed",
      }),
      event.turnCompleted(),
    ]);

    const legacySteerRow = timeline.rows.find(
      (
        row,
      ): row is Extract<TimelineRow, { kind: "conversation"; role: "user" }> =>
        row.kind === "conversation" && row.role === "user",
    );
    expect(legacySteerRow?.turnRequest.status).toBe("rejected");
    expect(timeline.text).toContain("steer failed");
    expect(timeline.text).not.toContain("steer pending");
  });

  it("does not apply an explicit rejection error to the next steer", () => {
    const event = createTimelineEventFactory({ threadId: "thread-1" });
    const turnStarted = event.turnStarted();
    const firstRequest = event.clientTurnRequested({
      target: { kind: "steer", expectedTurnId: "turn-1" },
      text: "First steer",
    });
    const secondRequest = event.clientTurnRequested({
      target: { kind: "steer", expectedTurnId: "turn-1" },
      text: "Second steer",
    });
    const timeline = renderActiveTimeline([
      turnStarted,
      firstRequest,
      secondRequest,
      event.clientTurnRejected({ requestId: firstRequest.data.requestId }),
      event.systemError({
        code: "thread_command_failed",
        message: "Command turn.submit failed",
      }),
    ]);

    const userRows = timeline.rows.filter(
      (
        row,
      ): row is Extract<TimelineRow, { kind: "conversation"; role: "user" }> =>
        row.kind === "conversation" && row.role === "user",
    );
    expect(userRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          text: "First steer",
          turnRequest: expect.objectContaining({ status: "rejected" }),
        }),
        expect.objectContaining({
          text: "Second steer",
          turnRequest: expect.objectContaining({ status: "pending" }),
        }),
      ]),
    );
  });

  it("places accepted active-turn steers at the acceptance position", () => {
    const event = createTimelineEventFactory({ threadId: "thread-1" });
    const steerRequest = event.clientTurnRequested({
      target: { kind: "auto", expectedTurnId: "turn-1" },
      text: "Please account for the restart",
    });
    const timeline = renderIdleTimeline([
      event.turnStarted(),
      event.commandCompleted({
        itemId: "tool-before-steer",
        command: "pnpm test",
      }),
      steerRequest,
      event.inputAccepted({
        clientRequestId: steerRequest.data.requestId,
      }),
      event.commandCompleted({
        itemId: "tool-after-steer",
        command: "sqlite3 ~/.bb-dev/bb.db '.tables'",
      }),
      event.assistantCompleted({ itemId: "assistant-1", text: "Done." }),
      event.turnCompleted(),
    ]);

    expect(messageKinds(timeline.messages)).toEqual([
      "command",
      "user",
      "command",
      "assistant-text",
    ]);
    const steerMessage = timeline.messages.find(
      (message) => message.kind === "user",
    );
    expect(steerMessage?.sourceSeqStart).toBe(4);
    expect(steerMessage?.turnRequest).toEqual({
      isGrouped: false,
      kind: "steer",
      status: "accepted",
    });
    expect(
      timeline.rows.filter(
        (row) =>
          row.kind === "conversation" &&
          row.role === "user" &&
          row.turnRequest.status === "pending",
      ),
    ).toHaveLength(0);
    const steerRow = timeline.rows.find(
      (row) => row.kind === "conversation" && row.role === "user",
    );
    expect(steerRow?.sourceSeqStart).toBe(4);
    expect(steerRow?.turnRequest).toEqual({
      isGrouped: false,
      kind: "steer",
      status: "accepted",
    });
    expect(timeline.turnRows).toHaveLength(2);
    expect(timeline.text).toMatchInlineSnapshot(`
      "── Worked for (0ms) ────────────────────────────────────────
        ── Ran pnpm test
          $ pnpm test

      ── User ────────────────────────────────────────────────────
      Please account for the restart
      steer

      ── Worked for (0ms) ────────────────────────────────────────
        ── Ran sqlite3 ~/.bb-dev/bb.db '.tables'
          $ sqlite3 ~/.bb-dev/bb.db '.tables'

      ── Assistant ───────────────────────────────────────────────
      Done."
    `);
  });

  it("keeps accepted regular follow-up messages as normal user rows", () => {
    const event = createTimelineEventFactory({ threadId: "thread-1" });
    const firstRequest = event.clientTurnRequested({
      target: { kind: "new-turn" },
      text: "First task",
    });
    const events: TimelineFixtureEvent[] = [
      firstRequest,
      event.turnStarted({ turnId: "turn-1" }),
      event.inputAccepted({
        clientRequestId: firstRequest.data.requestId,
        turnId: "turn-1",
      }),
      event.assistantCompleted({
        itemId: "assistant-1",
        text: "First done.",
        turnId: "turn-1",
      }),
      event.turnCompleted({ turnId: "turn-1" }),
    ];
    const followUpRequest = event.clientTurnRequested({
      target: { kind: "new-turn" },
      text: "Follow-up task",
    });
    events.push(
      followUpRequest,
      event.turnStarted({ turnId: "turn-2" }),
      event.inputAccepted({
        clientRequestId: followUpRequest.data.requestId,
        turnId: "turn-2",
      }),
      event.commandCompleted({
        itemId: "tool-follow-up",
        command: "pnpm test",
        turnId: "turn-2",
      }),
      event.assistantCompleted({
        itemId: "assistant-2",
        text: "Follow-up done.",
        turnId: "turn-2",
      }),
      event.turnCompleted({ turnId: "turn-2" }),
    );
    const timeline = renderIdleTimeline(events);

    const userMessages = timeline.messages.filter(
      (message) => message.kind === "user",
    );
    expect(userMessages).toHaveLength(2);
    expect(userMessages.map((message) => message.text)).toEqual([
      "First task",
      "Follow-up task",
    ]);
    expect(userMessages.map((message) => message.turnRequest)).toEqual([
      { isGrouped: false, kind: "message", status: "accepted" },
      { isGrouped: false, kind: "message", status: "accepted" },
    ]);
    const topLevelUserRows = timeline.rows.filter(
      (row) => row.kind === "conversation" && row.role === "user",
    );
    expect(topLevelUserRows.map((row) => row.text)).toEqual([
      "First task",
      "Follow-up task",
    ]);
    expect(timeline.turnRows).toHaveLength(1);
    expect(timeline.text).toMatchInlineSnapshot(`
      "── User ────────────────────────────────────────────────────
      First task

      ── Assistant ───────────────────────────────────────────────
      First done.

      ── User ────────────────────────────────────────────────────
      Follow-up task

      ── Worked for (4ms) ────────────────────────────────────────
        ── Ran pnpm test
          $ pnpm test

      ── Assistant ───────────────────────────────────────────────
      Follow-up done."
    `);
  });

  it("keeps completed thread provisioning after the initial user request", () => {
    const event = createTimelineEventFactory({ threadId: "thread-1" });
    const initialRequest = event.clientTurnRequested({
      requestMethod: "thread/start",
      source: "spawn",
      target: { kind: "thread-start" },
      text: "Start the workspace",
    });
    const timeline = renderActiveTimeline([
      initialRequest,
      event.threadProvisioning({
        status: "active",
        entries: [
          {
            type: "step",
            key: "workspace",
            text: "Preparing workspace",
            status: "started",
          },
        ],
      }),
      event.threadProvisioning({
        status: "completed",
        entries: [],
      }),
      event.turnStarted(),
      event.inputAccepted({
        clientRequestId: initialRequest.data.requestId,
      }),
      event.assistantCompleted({
        itemId: "assistant-1",
        text: "I can work now.",
      }),
    ]);

    expect(
      timeline.rows.map((row) => {
        if (row.kind === "conversation") {
          return `${row.role}:${row.text}`;
        }
        if (row.kind === "system") {
          return row.title;
        }
        return row.kind;
      }),
    ).toEqual([
      "user:Start the workspace",
      "Provisioned thread",
      "assistant:I can work now.",
    ]);
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

      ── Provisioning thread failed ──────────────────────────────
        Running setup
        pnpm install failed

      ── Error ───────────────────────────────────────────────────
        Provisioning thread failed
        pnpm install failed"
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

    expect(timeline.turnRows).toHaveLength(1);
    expect(timeline.turnRows[0]?.summaryCount).toBe(2);
    expect(timeline.text).toMatchInlineSnapshot(`
      "── Worked for (4ms) ────────────────────────────────────────
        ── Explored 1 search, ran 1 command
          ── Searched for TODO in packages/core-ui
          ── Ran pnpm test
            $ pnpm test
            Tests passed

      ── Assistant ───────────────────────────────────────────────
      The TODO sweep is clean."
    `);
  });

  it("shows pending context compaction with active wording", () => {
    const event = createTimelineEventFactory({ threadId: "thread-1" });
    const timeline = renderActiveTimeline([
      event.turnStarted(),
      event.contextCompactionStarted(),
    ]);

    expect(messageKinds(timeline.messages)).toEqual(["operation"]);
    expect(timeline.text).toMatchInlineSnapshot(`
      "── Compacting context ──────────────────────────────────────"
    `);
  });

  it("unwraps completed context compaction from a singleton turn summary", () => {
    const event = createTimelineEventFactory({ threadId: "thread-1" });
    const timeline = renderTimelineFixture({
      events: [
        event.turnStarted(),
        event.contextCompactionStarted(),
        event.assistantCompleted({
          itemId: "assistant-after-compaction",
          text: "Compaction finished.",
        }),
        event.threadCompacted(),
        event.turnCompleted(),
      ],
      includeNestedRows: false,
      projectionOptions: {
        threadStatus: "idle",
        turnMessageDetail: "summary",
      },
    });

    expect(timeline.turnRows).toHaveLength(0);
    expect(timeline.text).toContain("Context compacted");
    expect(timeline.text).toContain("Compaction finished.");
    expect(timeline.text).not.toContain("Worked for");
  });

  it("shows a context clear as its own completed timeline row", () => {
    const event = createTimelineEventFactory({ threadId: "thread-1" });
    const timeline = renderTimelineFixture({
      events: [
        event.turnStarted(),
        event.threadContextCleared(),
        event.turnCompleted(),
      ],
      includeNestedRows: false,
      projectionOptions: {
        threadStatus: "idle",
        turnMessageDetail: "summary",
      },
    });

    expect(messageKinds(timeline.messages)).toEqual(["operation"]);
    expect(timeline.turnRows).toHaveLength(0);
    expect(timeline.text).toMatchInlineSnapshot(`
      "── Context cleared ─────────────────────────────────────────"
    `);
    expect(timeline.text).not.toContain("Worked for");
  });

  it("unwraps failed context compaction from a singleton turn summary", () => {
    const event = createTimelineEventFactory({ threadId: "thread-1" });
    const timeline = renderTimelineFixture({
      events: [
        event.turnStarted(),
        event.contextCompactionStarted(),
        event.providerError({
          message: "Provider error",
          detail: "Nothing to compact",
        }),
        event.turnCompleted({ status: "failed" }),
      ],
      includeNestedRows: false,
      projectionOptions: {
        threadStatus: "error",
        turnMessageDetail: "summary",
      },
    });

    expect(timeline.turnRows).toHaveLength(0);
    expect(timeline.text).toContain("Context compaction failed");
    expect(timeline.text).not.toContain("Worked for");
  });

  it("keeps context compaction grouped when the turn contains other work", () => {
    const event = createTimelineEventFactory({ threadId: "thread-1" });
    const timeline = renderTimelineFixture({
      events: [
        event.turnStarted(),
        event.contextCompactionStarted(),
        event.contextCompactionCompleted(),
        event.commandCompleted({
          itemId: "command-1",
          command: "pnpm test",
          aggregatedOutput: "Tests passed\n",
          exitCode: 0,
        }),
        event.turnCompleted(),
      ],
      includeNestedRows: false,
      projectionOptions: {
        threadStatus: "idle",
        turnMessageDetail: "summary",
      },
    });

    expect(timeline.turnRows).toHaveLength(1);
    expect(timeline.text).toContain("Worked for");
  });

  it("keeps a finished-turn summary when work follows an assistant step", () => {
    const event = createTimelineEventFactory({ threadId: "thread-1" });
    const timeline = renderIdleTimeline([
      event.turnStarted(),
      event.commandCompleted({
        itemId: "call-1",
        command: "/bin/zsh -lc 'pnpm test'",
        aggregatedOutput: "Tests passed\n",
        exitCode: 0,
      }),
      event.assistantCompleted({
        itemId: "assistant-1",
        text: "I found the test path.",
      }),
      event.commandCompleted({
        itemId: "call-2",
        command:
          "/bin/zsh -lc 'rg setState packages/excalidraw/tests/helpers/ui.ts'",
        aggregatedOutput:
          "packages/excalidraw/tests/helpers/ui.ts:42: setState\n",
        exitCode: 0,
      }),
      event.turnCompleted(),
    ]);

    expect(timeline.turnRows).toHaveLength(1);
    expect(timeline.turnRows[0]).toMatchObject({
      sourceSeqStart: 1,
      sourceSeqEnd: 5,
    });
    expect(timeline.text).toMatchInlineSnapshot(`
      "── Worked for (4ms) ────────────────────────────────────────
        ── Ran pnpm test
          $ pnpm test
          Tests passed

      ── Assistant ───────────────────────────────────────────────
      I found the test path.

      ── Searched for setState in packages/excalidraw/tests/helpers/ui.ts
        $ rg setState packages/excalidraw/tests/helpers/ui.ts"
    `);
  });

  it("keeps summary projections compact with a finished-turn summary", () => {
    const event = createTimelineEventFactory({ threadId: "thread-1" });
    const timeline = renderTimelineFixture({
      events: [
        event.turnStarted(),
        event.commandCompleted({
          itemId: "call-1",
          command: "/bin/zsh -lc 'pnpm test'",
        }),
        event.assistantCompleted({
          itemId: "assistant-1",
          text: "I found the test path.",
        }),
        event.commandCompleted({
          itemId: "call-2",
          command:
            "/bin/zsh -lc 'rg setState packages/excalidraw/tests/helpers/ui.ts'",
        }),
        event.assistantCompleted({
          itemId: "assistant-2",
          text: "Done.",
        }),
        event.turnCompleted(),
      ],
      includeNestedRows: false,
      projectionOptions: {
        threadStatus: "idle",
        turnMessageDetail: "summary",
      },
    });

    expect(timeline.turnRows).toHaveLength(1);
    expect(timeline.turnRows[0]).toMatchObject({
      sourceSeqStart: 1,
      sourceSeqEnd: 6,
    });
    expect(timeline.text).toMatchInlineSnapshot(`
      "── Worked for (5ms) ────────────────────────────────────────

      ── Assistant ───────────────────────────────────────────────
      Done."
    `);
  });

  it("scopes nested delegation row ids", () => {
    const event = createTimelineEventFactory({
      providerThreadId: "root-provider",
      threadId: "thread-1",
      turnId: "turn-1",
    });
    const timeline = renderIdleTimeline([
      event.turnStarted(),
      event.delegationCompleted({
        itemId: "delegation-1",
        childRef: "child-provider",
        label: "Review the branch",
        summary: "Child result",
      }),
      event.commandCompleted({
        providerThreadId: "child-provider",
        itemId: "child-command-1",
        command: "echo child",
        aggregatedOutput: "child\n",
      }),
      event.assistantCompleted({
        providerThreadId: "child-provider",
        itemId: "child-assistant-1",
        text: "Child done.",
      }),
      event.assistantCompleted({
        itemId: "root-assistant-1",
        text: "Root done.",
      }),
      event.turnCompleted(),
    ]);

    const allRows = flattenTimelineRows(timeline.rows);
    const rootTurn = timeline.rows.find(
      (row): row is Extract<TimelineRow, { kind: "turn" }> =>
        row.kind === "turn",
    );
    const delegation = allRows.find(
      (
        row,
      ): row is Extract<
        TimelineRow,
        { kind: "work"; workKind: "delegation" }
      > => row.kind === "work" && row.workKind === "delegation",
    );

    expect(rootTurn).toBeDefined();
    expect(delegation).toBeDefined();
    expect(delegation?.childRows.some((row) => row.kind === "turn")).toBe(
      false,
    );
    expect(delegation?.childRows.length ?? 0).toBeGreaterThan(0);
    for (const childRow of delegation?.childRows ?? []) {
      expect(childRow.id.startsWith(`${delegation?.id}:child:`)).toBe(true);
    }
  });

  it("nests Codex same-provider child turns under spawn delegations", () => {
    const event = createTimelineEventFactory({
      providerThreadId: "root-provider",
      threadId: "thread-1",
      turnId: "turn-1",
    });
    const timeline = renderIdleTimeline([
      event.turnStarted(),
      event.delegationStarted({
        itemId: "delegation-1",
        childRef: "root-provider",
        label: "Review architecture",
      }),
      event.delegationCompleted({
        itemId: "delegation-1",
        childRef: "root-provider",
        label: "Review architecture",
      }),
      event.delegationStarted({
        itemId: "delegation-2",
        childRef: "root-provider",
        label: "Review UI",
      }),
      event.turnStarted({ turnId: "child-turn-1" }),
      event.delegationCompleted({
        itemId: "delegation-2",
        childRef: "root-provider",
        label: "Review UI",
      }),
      event.turnStarted({ turnId: "child-turn-2" }),
      event.commandCompleted({
        itemId: "child-command-1",
        turnId: "child-turn-1",
        command: "pnpm test",
        aggregatedOutput: "ok\n",
      }),
      event.assistantCompleted({
        itemId: "child-assistant-1",
        turnId: "child-turn-1",
        text: "Architecture is fine.",
      }),
      event.turnCompleted({ turnId: "child-turn-1" }),
      event.assistantCompleted({
        itemId: "child-assistant-2",
        turnId: "child-turn-2",
        text: "UI has one issue.",
      }),
      event.turnCompleted({ turnId: "child-turn-2" }),
      event.assistantCompleted({
        itemId: "root-assistant-1",
        text: "Root done.",
      }),
      event.turnCompleted(),
    ]);

    const allRows = flattenTimelineRows(timeline.rows);
    const delegations = allRows.filter(
      (
        row,
      ): row is Extract<
        TimelineRow,
        { kind: "work"; workKind: "delegation" }
      > => row.kind === "work" && row.workKind === "delegation",
    );
    const topLevelChildTurns = timeline.rows.filter(
      (row) => row.kind === "turn" && row.turnId.startsWith("child-turn-"),
    );
    const topLevelChildMessages = timeline.rows.filter(
      (row) =>
        row.kind === "conversation" &&
        row.turnId?.startsWith("child-turn-") === true,
    );

    expect(delegations).toHaveLength(2);
    expect(topLevelChildTurns).toHaveLength(0);
    expect(topLevelChildMessages).toHaveLength(0);
    expect(delegations[0]?.childRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "conversation",
          role: "assistant",
          text: "Architecture is fine.",
          turnId: "child-turn-1",
        }),
      ]),
    );
    expect(delegations[1]?.childRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "conversation",
          role: "assistant",
          text: "UI has one issue.",
          turnId: "child-turn-2",
        }),
      ]),
    );
    expect(
      delegations.some((delegation) =>
        delegation.childRows.some((row) => row.kind === "turn"),
      ),
    ).toBe(false);
  });

  it("preserves a root assistant stream when a nested turn completes first", () => {
    const event = createTimelineEventFactory({
      providerThreadId: "root-provider",
      threadId: "thread-1",
      turnId: "root-turn",
    });
    const timeline = renderIdleTimeline([
      event.turnStarted(),
      event.toolCallStarted({
        itemId: "delegation-1",
        tool: "spawnAgent",
        arguments: {
          prompt: "Research the issue",
          receiverThreadIds: ["child-provider"],
        },
      }),
      event.turnStarted({
        parentToolCallId: "delegation-1",
        turnId: "child-turn",
      }),
      event.assistantDelta({
        delta: "I",
        itemId: "root-assistant",
      }),
      event.assistantCompleted({
        itemId: "child-assistant",
        text: "Child research complete.",
        turnId: "child-turn",
      }),
      event.turnCompleted({ turnId: "child-turn" }),
      event.toolCallCompleted({
        itemId: "delegation-1",
        tool: "spawnAgent",
        arguments: {
          prompt: "Research the issue",
          receiverThreadIds: ["child-provider"],
        },
      }),
      event.assistantCompleted({
        itemId: "root-assistant",
        text: "I recommend applying the focused fix.",
      }),
      event.turnCompleted(),
    ]);

    const rootAssistantRows = timeline.rows.filter(
      (row) =>
        row.kind === "conversation" &&
        row.role === "assistant" &&
        row.turnId === "root-turn",
    );
    expect(rootAssistantRows).toEqual([
      expect.objectContaining({
        text: "I recommend applying the focused fix.",
      }),
    ]);
  });

  it("keeps root reasoning active when a nested reasoning lifecycle completes first", () => {
    const event = createTimelineEventFactory({
      providerThreadId: "root-provider",
      threadId: "thread-1",
      turnId: "root-turn",
    });
    const timeline = renderActiveTimeline([
      event.turnStarted(),
      event.toolCallStarted({
        itemId: "delegation-1",
        tool: "spawnAgent",
        arguments: {
          prompt: "Research the issue",
          receiverThreadIds: ["child-provider"],
        },
      }),
      event.turnStarted({
        parentToolCallId: "delegation-1",
        turnId: "child-turn",
      }),
      event.reasoningDelta({
        delta: "Root is still thinking.\n",
        itemId: "root-reasoning",
      }),
      event.reasoningDelta({
        delta: "Child thought.",
        itemId: "child-reasoning",
        parentToolCallId: "delegation-1",
        turnId: "child-turn",
      }),
      event.turnCompleted({ createdAt: 5_000, turnId: "child-turn" }),
    ]);

    expect(timeline.projection.state.activeThinking).toMatchObject({
      id: "root-reasoning",
      text: "Root is still thinking.\n",
    });
    expect(
      timeline.messages.filter((message) => message.kind === "operation"),
    ).toEqual([
      expect.objectContaining({
        detail: "Child thought.",
        parentToolCallId: "delegation-1",
        scope: { kind: "turn", turnId: "child-turn" },
        status: "completed",
        title: "Thought for 5s",
      }),
    ]);
  });

  it("does not attach later root turns to Claude receiver-thread delegations", () => {
    const event = createTimelineEventFactory({
      providerThreadId: "root-provider",
      threadId: "thread-1",
      turnId: "turn-1",
    });
    const timeline = renderActiveTimeline([
      event.turnStarted(),
      event.delegationStarted({
        itemId: "delegation-1",
        childRef: "child-provider",
        label: "Review with a child provider thread",
      }),
      event.commandStarted({
        providerThreadId: "child-provider",
        itemId: "child-command-1",
        command: "pnpm test",
      }),
      event.turnStarted({ turnId: "turn-2" }),
      event.assistantCompleted({
        itemId: "root-assistant-2",
        turnId: "turn-2",
        text: "Root follow-up is separate.",
      }),
    ]);

    const allRows = flattenTimelineRows(timeline.rows);
    const delegation = allRows.find(
      (
        row,
      ): row is Extract<
        TimelineRow,
        { kind: "work"; workKind: "delegation" }
      > => row.kind === "work" && row.workKind === "delegation",
    );
    const rootFollowUp = timeline.rows.find(
      (row) =>
        row.kind === "conversation" &&
        row.role === "assistant" &&
        row.turnId === "turn-2",
    );

    expect(delegation).toBeDefined();
    expect(delegation?.childRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "work",
          workKind: "command",
          turnId: "turn-1",
        }),
      ]),
    );
    expect(delegation?.childRows.some((row) => row.turnId === "turn-2")).toBe(
      false,
    );
    expect(rootFollowUp).toMatchObject({
      kind: "conversation",
      role: "assistant",
      text: "Root follow-up is separate.",
      turnId: "turn-2",
    });
  });

  it("nests explicit Claude subagent messages inside accepted root turns", () => {
    const event = createTimelineEventFactory({
      providerThreadId: "root-provider",
      threadId: "thread-1",
      turnId: "turn-1",
    });
    const startRequest = event.clientTurnRequested({
      target: { kind: "thread-start" },
      text: "Run a Claude Code subagent.",
    });
    const timeline = renderActiveTimeline([
      startRequest,
      event.turnStarted(),
      event.inputAccepted({
        clientRequestId: startRequest.data.requestId,
      }),
      event.toolCallStarted({
        itemId: "toolu_agent_1",
        tool: "Agent",
        arguments: {
          prompt: "Reply with FIRST_SUBAGENT_OUTPUT.",
          subagent_type: "general-purpose",
        },
      }),
      event.toolCallCompleted({
        itemId: "toolu_agent_1",
        tool: "Agent",
        arguments: {
          prompt: "Reply with FIRST_SUBAGENT_OUTPUT.",
          subagent_type: "general-purpose",
        },
        result: "FIRST_SUBAGENT_OUTPUT",
      }),
      event.assistantCompleted({
        itemId: "subagent-message-1",
        parentToolCallId: "toolu_agent_1",
        text: "SECOND_SUBAGENT_OUTPUT",
      }),
      event.assistantCompleted({
        itemId: "main-assistant-1",
        text: "MAIN_DONE_AFTER_SENDMESSAGE",
      }),
    ]);

    const allRows = flattenTimelineRows(timeline.rows);
    const delegation = allRows.find(
      (
        row,
      ): row is Extract<
        TimelineRow,
        { kind: "work"; workKind: "delegation" }
      > => row.kind === "work" && row.workKind === "delegation",
    );
    const topLevelSubagentOutput = timeline.rows.find(
      (row) =>
        row.kind === "conversation" &&
        row.role === "assistant" &&
        row.text === "SECOND_SUBAGENT_OUTPUT",
    );

    expect(delegation).toBeDefined();
    expect(delegation?.childRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "conversation",
          role: "assistant",
          text: "SECOND_SUBAGENT_OUTPUT",
          turnId: "turn-1",
        }),
      ]),
    );
    expect(topLevelSubagentOutput).toBeUndefined();
    expect(timeline.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "conversation",
          role: "assistant",
          text: "MAIN_DONE_AFTER_SENDMESSAGE",
          turnId: "turn-1",
        }),
      ]),
    );
  });

  it("nests explicit Claude subagent messages from later accepted root turns", () => {
    const event = createTimelineEventFactory({
      providerThreadId: "root-provider",
      threadId: "thread-1",
      turnId: "turn-1",
    });
    const startRequest = event.clientTurnRequested({
      target: { kind: "thread-start" },
      text: "Start an echo subagent.",
    });
    const events: TimelineFixtureEvent[] = [
      startRequest,
      event.turnStarted(),
      event.inputAccepted({
        clientRequestId: startRequest.data.requestId,
      }),
      event.toolCallStarted({
        itemId: "toolu_agent_1",
        tool: "Agent",
        arguments: {
          prompt: "Echo messages.",
          run_in_background: true,
        },
      }),
      event.toolCallCompleted({
        itemId: "toolu_agent_1",
        tool: "Agent",
        arguments: {
          prompt: "Echo messages.",
          run_in_background: true,
        },
        result: "Async agent launched successfully.",
      }),
      event.assistantCompleted({
        itemId: "subagent-ready",
        parentToolCallId: "toolu_agent_1",
        text: "READY",
      }),
      event.turnCompleted(),
    ];
    const sendRequest = event.clientTurnRequested({
      target: { kind: "new-turn" },
      text: "Send HELLO to the echo subagent.",
    });
    events.push(
      sendRequest,
      event.turnStarted({ turnId: "turn-2" }),
      event.inputAccepted({
        clientRequestId: sendRequest.data.requestId,
        turnId: "turn-2",
      }),
      event.toolCallStarted({
        itemId: "toolu_send_1",
        tool: "SendMessage",
        turnId: "turn-2",
        arguments: {
          content: "HELLO",
          recipient: "subagent-1",
        },
      }),
      event.toolCallCompleted({
        itemId: "toolu_send_1",
        tool: "SendMessage",
        turnId: "turn-2",
        arguments: {
          content: "HELLO",
          recipient: "subagent-1",
        },
        result: "Message sent.",
      }),
      event.assistantCompleted({
        itemId: "subagent-hello",
        parentToolCallId: "toolu_agent_1",
        text: "HELLO",
        turnId: "turn-2",
      }),
      event.assistantCompleted({
        itemId: "main-after-send",
        text: "Sent HELLO.",
        turnId: "turn-2",
      }),
    );
    const timeline = renderActiveTimeline(events);

    const allRows = flattenTimelineRows(timeline.rows);
    const delegation = allRows.find(
      (
        row,
      ): row is Extract<
        TimelineRow,
        { kind: "work"; workKind: "delegation" }
      > => row.kind === "work" && row.workKind === "delegation",
    );
    const sendTurn = timeline.rows.find(
      (row): row is Extract<TimelineRow, { kind: "turn" }> =>
        row.kind === "turn" && row.turnId === "turn-2",
    );

    expect(delegation).toBeDefined();
    expect(delegation?.childRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "conversation",
          role: "assistant",
          text: "READY",
          turnId: "turn-1",
        }),
        expect.objectContaining({
          kind: "conversation",
          role: "assistant",
          text: "HELLO",
          turnId: "turn-2",
        }),
      ]),
    );
    expect(
      flattenTimelineRows(sendTurn?.children ?? []).some(
        (row) =>
          row.kind === "conversation" &&
          row.role === "assistant" &&
          row.text === "HELLO",
      ),
    ).toBe(false);
  });

  it("does not attach later human turns to Codex same-provider receiver delegations", () => {
    const event = createTimelineEventFactory({
      providerThreadId: "root-provider",
      threadId: "thread-1",
      turnId: "parent-turn",
    });
    const parentToolCallId = "call_MV1jTrxEd9bsYdEXQo1PhVOs";
    const timeline = renderActiveTimeline([
      event.turnStarted(),
      event.toolCallStarted({
        itemId: parentToolCallId,
        tool: "spawnAgent",
        arguments: {
          prompt: "Run the child command",
          senderThreadId: "root-provider",
          receiverThreadIds: ["root-provider"],
        },
      }),
      event.turnCompleted(),
      event.turnStarted({
        turnId: "child-turn",
        parentToolCallId,
      }),
      event.commandStarted({
        itemId: "child-command",
        turnId: "child-turn",
        command: "/bin/zsh -lc 'sleep 20; echo CHILD_REAL_PROVIDER_DONE'",
      }),
      event.turnStarted({ turnId: "follow-up-turn" }),
      event.assistantCompleted({
        itemId: "follow-up-assistant",
        turnId: "follow-up-turn",
        text: "follow-up done",
      }),
      event.commandCompleted({
        itemId: "child-command",
        turnId: "child-turn",
        command: "/bin/zsh -lc 'sleep 20; echo CHILD_REAL_PROVIDER_DONE'",
        aggregatedOutput: "CHILD_REAL_PROVIDER_DONE\n",
      }),
    ]);

    const allRows = flattenTimelineRows(timeline.rows);
    const delegation = allRows.find(
      (
        row,
      ): row is Extract<
        TimelineRow,
        { kind: "work"; workKind: "delegation" }
      > => row.kind === "work" && row.workKind === "delegation",
    );
    const rootFollowUp = timeline.rows.find(
      (row) =>
        row.kind === "conversation" &&
        row.role === "assistant" &&
        row.turnId === "follow-up-turn",
    );

    expect(delegation).toBeDefined();
    expect(delegation?.childRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "work",
          workKind: "command",
          turnId: "child-turn",
        }),
      ]),
    );
    expect(
      delegation?.childRows.some((row) => row.turnId === "follow-up-turn"),
    ).toBe(false);
    expect(rootFollowUp).toMatchObject({
      kind: "conversation",
      role: "assistant",
      text: "follow-up done",
      turnId: "follow-up-turn",
    });
  });

  it("keeps accepted human turns top-level when persisted Codex child links are stale", () => {
    const event = createTimelineEventFactory({
      providerThreadId: "root-provider",
      threadId: "thread-1",
      turnId: "parent-turn",
    });
    const parentToolCallId = "call_XLYYu5d3CKM9X51TRxrIJauc";
    const followUpRequest = event.clientTurnRequested({
      target: { kind: "new-turn" },
      text: "Queued follow-up during delegated child work.",
    });
    const timeline = renderActiveTimeline([
      event.turnStarted(),
      event.toolCallStarted({
        itemId: parentToolCallId,
        tool: "spawnAgent",
        arguments: {
          prompt: "Run the child command",
          senderThreadId: "root-provider",
          receiverThreadIds: [],
        },
      }),
      event.toolCallCompleted({
        itemId: parentToolCallId,
        tool: "spawnAgent",
        arguments: {
          prompt: "Run the child command",
          senderThreadId: "root-provider",
          receiverThreadIds: ["child-provider-thread"],
        },
        result: {
          "child-provider-thread": {
            status: "pendingInit",
            message: null,
          },
        },
      }),
      event.turnStarted({
        turnId: "child-turn",
        parentToolCallId,
      }),
      event.commandStarted({
        itemId: "child-command",
        turnId: "child-turn",
        command: "/bin/zsh -lc 'sleep 20; echo CHILD_REAL_PROVIDER_DONE'",
        parentToolCallId,
      }),
      event.turnCompleted({ turnId: "parent-turn" }),
      followUpRequest,
      event.turnStarted({
        turnId: "follow-up-turn",
        parentToolCallId,
      }),
      event.inputAccepted({
        clientRequestId: followUpRequest.data.requestId,
        turnId: "follow-up-turn",
      }),
      event.assistantCompleted({
        itemId: "follow-up-assistant",
        turnId: "follow-up-turn",
        text: "follow-up done",
        parentToolCallId,
      }),
      event.commandCompleted({
        itemId: "child-command",
        turnId: "child-turn",
        command: "/bin/zsh -lc 'sleep 20; echo CHILD_REAL_PROVIDER_DONE'",
        aggregatedOutput: "CHILD_REAL_PROVIDER_DONE\n",
        parentToolCallId,
      }),
    ]);

    const allRows = flattenTimelineRows(timeline.rows);
    const delegation = allRows.find(
      (
        row,
      ): row is Extract<
        TimelineRow,
        { kind: "work"; workKind: "delegation" }
      > => row.kind === "work" && row.workKind === "delegation",
    );
    const rootFollowUp = timeline.rows.find(
      (row) =>
        row.kind === "conversation" &&
        row.role === "assistant" &&
        row.turnId === "follow-up-turn",
    );

    expect(delegation).toBeDefined();
    expect(delegation?.childRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "work",
          workKind: "command",
          turnId: "child-turn",
        }),
      ]),
    );
    expect(
      delegation?.childRows.some((row) => row.turnId === "follow-up-turn"),
    ).toBe(false);
    expect(rootFollowUp).toMatchObject({
      kind: "conversation",
      role: "assistant",
      text: "follow-up done",
      turnId: "follow-up-turn",
    });
  });

  it("keeps streaming Codex same-provider child turns out of top-level rows", () => {
    const event = createTimelineEventFactory({
      providerThreadId: "root-provider",
      threadId: "thread-1",
      turnId: "turn-1",
    });
    const timeline = renderActiveTimeline([
      event.turnStarted(),
      event.delegationStarted({
        itemId: "delegation-1",
        childRef: "root-provider",
        label: "Keep reviewing",
      }),
      event.turnStarted({ turnId: "child-turn-1" }),
      event.commandStarted({
        itemId: "child-command-1",
        turnId: "child-turn-1",
        command: "pnpm test",
      }),
      event.assistantDelta({
        itemId: "child-assistant-1",
        turnId: "child-turn-1",
        delta: "Still reviewing",
      }),
      event.assistantCompleted({
        itemId: "root-assistant-1",
        text: "Root is still waiting.",
      }),
    ]);

    const allRows = flattenTimelineRows(timeline.rows);
    const delegation = allRows.find(
      (
        row,
      ): row is Extract<
        TimelineRow,
        { kind: "work"; workKind: "delegation" }
      > => row.kind === "work" && row.workKind === "delegation",
    );
    const topLevelChildRows = timeline.rows.filter(
      (row) => row.turnId?.startsWith("child-turn-") === true,
    );

    expect(delegation).toBeDefined();
    expect(delegation?.status).toBe("pending");
    expect(topLevelChildRows).toHaveLength(0);
    expect(delegation?.childRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "work",
          workKind: "command",
          status: "pending",
          command: "pnpm test",
          turnId: "child-turn-1",
        }),
      ]),
    );
  });

  it("nests persisted child turns from turn started parent ids", () => {
    const event = createTimelineEventFactory({
      providerThreadId: "root-provider",
      threadId: "thread-1",
      turnId: "turn-1",
    });
    const timeline = renderIdleTimeline([
      event.turnStarted(),
      event.toolCallStarted({
        itemId: "delegation-1",
        tool: "spawnAgent",
        arguments: {
          prompt: "Review the branch",
          receiverThreadIds: ["child-provider"],
        },
      }),
      event.turnStarted({
        turnId: "child-turn-1",
        parentToolCallId: "delegation-1",
      }),
      event.assistantCompleted({
        itemId: "child-assistant-1",
        turnId: "child-turn-1",
        text: "Child done.",
      }),
      event.turnCompleted({ turnId: "child-turn-1" }),
      event.turnCompleted(),
    ]);

    const allRows = flattenTimelineRows(timeline.rows);
    const delegation = allRows.find(
      (
        row,
      ): row is Extract<
        TimelineRow,
        { kind: "work"; workKind: "delegation" }
      > => row.kind === "work" && row.workKind === "delegation",
    );
    const topLevelChildRows = timeline.rows.filter(
      (row) => row.turnId === "child-turn-1",
    );

    expect(topLevelChildRows).toHaveLength(0);
    expect(delegation?.childRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "conversation",
          role: "assistant",
          text: "Child done.",
          turnId: "child-turn-1",
        }),
      ]),
    );
  });

  it("drains pending same-provider links when child turns have explicit parent ids", () => {
    const event = createTimelineEventFactory({
      providerThreadId: "root-provider",
      threadId: "thread-1",
      turnId: "turn-1",
    });
    const timeline = renderActiveTimeline([
      event.turnStarted(),
      event.toolCallStarted({
        itemId: "delegation-1",
        tool: "spawnAgent",
        arguments: {
          prompt: "Review the branch",
          receiverThreadIds: [],
        },
      }),
      event.turnStarted({
        turnId: "child-turn-1",
        parentToolCallId: "delegation-1",
      }),
      event.assistantCompleted({
        itemId: "child-assistant-1",
        turnId: "child-turn-1",
        text: "Child done.",
      }),
      event.turnCompleted({ turnId: "child-turn-1" }),
      event.turnCompleted(),
      event.turnStarted({ turnId: "turn-2" }),
      event.assistantCompleted({
        itemId: "root-assistant-2",
        turnId: "turn-2",
        text: "Root follow-up is separate.",
      }),
    ]);

    const allRows = flattenTimelineRows(timeline.rows);
    const delegation = allRows.find(
      (
        row,
      ): row is Extract<
        TimelineRow,
        { kind: "work"; workKind: "delegation" }
      > => row.kind === "work" && row.workKind === "delegation",
    );
    const rootFollowUp = timeline.rows.find(
      (row) =>
        row.kind === "conversation" &&
        row.role === "assistant" &&
        row.turnId === "turn-2",
    );

    expect(delegation?.childRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "conversation",
          role: "assistant",
          text: "Child done.",
          turnId: "child-turn-1",
        }),
      ]),
    );
    expect(delegation?.childRows.some((row) => row.turnId === "turn-2")).toBe(
      false,
    );
    expect(rootFollowUp).toMatchObject({
      kind: "conversation",
      role: "assistant",
      text: "Root follow-up is separate.",
      turnId: "turn-2",
    });
  });

  it("renders pending delegation children as flat rows even with mixed statuses", () => {
    const event = createTimelineEventFactory({
      providerThreadId: "root-provider",
      threadId: "thread-1",
      turnId: "turn-1",
    });
    const timeline = renderActiveTimeline([
      event.turnStarted(),
      event.delegationStarted({
        itemId: "delegation-1",
        childRef: "child-provider",
        label: "Investigate the timeline",
      }),
      event.commandCompleted({
        providerThreadId: "child-provider",
        itemId: "child-command-completed",
        command: "git status",
        aggregatedOutput: "clean",
      }),
      event.commandCompleted({
        providerThreadId: "child-provider",
        itemId: "child-command-errored",
        command: "git diff main..HEAD",
        aggregatedOutput: "",
        status: "failed",
      }),
      event.commandStarted({
        providerThreadId: "child-provider",
        itemId: "child-command-pending",
        command: "git log --oneline",
      }),
    ]);

    const allRows = flattenTimelineRows(timeline.rows);
    const delegation = allRows.find(
      (
        row,
      ): row is Extract<
        TimelineRow,
        { kind: "work"; workKind: "delegation" }
      > => row.kind === "work" && row.workKind === "delegation",
    );

    expect(delegation).toBeDefined();
    expect(delegation?.status).toBe("pending");
    expect(delegation?.childRows.some((row) => row.kind === "turn")).toBe(
      false,
    );
    expect(delegation?.childRows.length ?? 0).toBeGreaterThanOrEqual(3);
    expect(timeline.text).not.toContain("Worked for");
    expect(timeline.text).not.toContain("Working for");
  });

  it("counts lists separately while de-duping explored files", () => {
    const event = createTimelineEventFactory({ threadId: "thread-1" });
    const timeline = renderIdleTimeline([
      event.turnStarted(),
      event.commandCompleted({
        itemId: "read-1",
        command: "/bin/zsh -lc 'cat src/a.ts'",
      }),
      event.commandCompleted({
        itemId: "read-2",
        command: "/bin/zsh -lc 'cat src/a.ts'",
      }),
      event.commandCompleted({
        itemId: "list-1",
        command: "/bin/zsh -lc 'ls src'",
      }),
      event.commandCompleted({
        itemId: "list-2",
        command: "/bin/zsh -lc 'find test -maxdepth 1'",
      }),
      event.commandCompleted({
        itemId: "search-1",
        command: "/bin/zsh -lc 'rg TODO src'",
      }),
      event.assistantCompleted({
        itemId: "assistant-1",
        text: "Done.",
      }),
      event.turnCompleted(),
    ]);

    expect(timeline.text).toMatchInlineSnapshot(`
      "── Worked for (7ms) ────────────────────────────────────────
        ── Explored 1 file, 2 lists, 1 search
          ── Read src/a.ts
          ── Listed files in src
          ── Listed files in test
          ── Searched for TODO in src

      ── Assistant ───────────────────────────────────────────────
      Done."
    `);
  });

  it("summarizes file changes by action while preserving repeated change rows", () => {
    const event = createTimelineEventFactory({ threadId: "thread-1" });
    const timeline = renderIdleTimeline([
      event.turnStarted(),
      event.fileChangeCompleted({
        itemId: "edit-1",
        changes: [
          {
            path: "/repo/src/a.ts",
            kind: "add",
            diff: "@@ -0,0 +1 @@\n+first",
          },
        ],
      }),
      event.fileChangeCompleted({
        itemId: "edit-2",
        changes: [
          {
            path: "/repo/src/a.ts",
            kind: "update",
            diff: "@@ -1 +1 @@\n-first\n+second",
          },
        ],
      }),
      event.fileChangeCompleted({
        itemId: "edit-3",
        changes: [
          {
            path: "/repo/src/b.ts",
            kind: "update",
            diff: "@@ -1 +1 @@\n-before\n+after",
          },
        ],
      }),
      event.fileChangeCompleted({
        itemId: "edit-4",
        changes: [
          {
            path: "/repo/src/c.ts",
            kind: "delete",
            diff: "@@ -1 +0,0 @@\n-old",
          },
        ],
      }),
      event.assistantCompleted({
        itemId: "assistant-1",
        text: "Done.",
      }),
      event.turnCompleted(),
    ]);

    expect(timeline.text).toMatchInlineSnapshot(`
      "── Worked for (6ms) ────────────────────────────────────────
        ── Edited 4 files
          ── Created /repo/src/a.ts +1
            @@ -0,0 +1 @@
            +first
          ── Edited /repo/src/a.ts +1 -1
            @@ -1 +1 @@
            -first
            +second
          ── Edited /repo/src/b.ts +1 -1
            @@ -1 +1 @@
            -before
            +after
          ── Deleted /repo/src/c.ts -1
            @@ -1 +0,0 @@
            -old

      ── Assistant ───────────────────────────────────────────────
      Done."
    `);
  });

  it("computes file-change stats from raw created and deleted file bodies", () => {
    const event = createTimelineEventFactory({ threadId: "thread-1" });
    const timeline = renderIdleTimeline([
      event.turnStarted(),
      event.fileChangeCompleted({
        itemId: "edit-1",
        changes: [
          {
            path: "/repo/src/created.ts",
            kind: "add",
            diff: "first line\nsecond line\n",
          },
          {
            path: "/repo/src/deleted.ts",
            kind: "delete",
            diff: "old first\nold second\n",
          },
        ],
      }),
      event.turnCompleted(),
    ]);

    expect(timeline.text).toMatchInlineSnapshot(`
      "── Worked for (2ms) ────────────────────────────────────────
        ── Edited 2 files
          ── Created /repo/src/created.ts +2
            first line
            second line
          ── Deleted /repo/src/deleted.ts -2
            old first
            old second"
    `);
  });

  it("retains completed reasoning through the generic system operation row", () => {
    const event = createTimelineEventFactory({ threadId: "thread-1" });
    const events = [
      event.turnStarted({ createdAt: 0 }),
      event.reasoningStarted({
        createdAt: 1_000,
        itemId: "reasoning-1",
      }),
      event.reasoningDelta({
        createdAt: 2_000,
        itemId: "reasoning-1",
        delta: "I should inspect the nearby files first.",
      }),
      event.reasoningCompleted({
        createdAt: 4_000,
        itemId: "reasoning-1",
        text: "I should inspect the projection seam first.",
      }),
      event.toolCallCompleted({
        createdAt: 5_000,
        itemId: "tool-1",
        arguments: { cmd: "sed -n '1,80p' packages/core-ui/src/index.ts" },
      }),
      event.assistantCompleted({
        createdAt: 6_000,
        itemId: "assistant-1",
        text: "The extension point is the timeline row builder.",
      }),
      event.turnCompleted({ createdAt: 7_000 }),
    ];
    const timeline = renderIdleTimeline(events);
    const reloadedTimeline = renderIdleTimeline(events);

    expect(timeline.turnRows).toHaveLength(1);
    expect(timeline.turnRows[0]?.summaryCount).toBe(2);
    expect(
      timeline.messages.filter((message) => message.kind === "operation"),
    ).toEqual([
      {
        kind: "operation",
        id: "thread-1:op:reasoning:kind:reasoning|turn:turn-1|parent:root|item:reasoning-1",
        threadId: "thread-1",
        sourceSeqStart: 2,
        sourceSeqEnd: 4,
        createdAt: 4_000,
        startedAt: 1_000,
        completedAt: 4_000,
        scope: { kind: "turn", turnId: "turn-1" },
        opType: "operation",
        title: "Thought for 3s",
        detail: "I should inspect the projection seam first.",
        status: "completed",
      },
    ]);
    expect(reloadedTimeline.text).toBe(timeline.text);
    expect(timeline.text).toMatchInlineSnapshot(`
      "── Worked for (7s) ─────────────────────────────────────────
        ── Thought for 3s
          I should inspect the projection seam first.

        ── Ran tool exec_command { cmd: sed -n '1,80p' packages/core-ui/src/i... }

      ── Assistant ───────────────────────────────────────────────
      The extension point is the timeline row builder."
    `);
  });

  it("keeps completed reasoning at root when provider parent scope is suppressed", () => {
    const event = createTimelineEventFactory({ threadId: "thread-1" });
    const startRequest = event.clientTurnRequested({
      target: { kind: "thread-start" },
      text: "Inspect the projection.",
    });
    const timeline = renderIdleTimeline([
      startRequest,
      event.turnStarted({
        createdAt: 1_000,
        parentToolCallId: "stale-parent",
      }),
      event.inputAccepted({
        clientRequestId: startRequest.data.requestId,
        createdAt: 1_500,
      }),
      event.reasoningStarted({
        createdAt: 2_000,
        itemId: "reasoning-1",
        parentToolCallId: "stale-parent",
      }),
      event.reasoningDelta({
        createdAt: 3_000,
        delta: "Checking effective scope.",
        itemId: "reasoning-1",
        parentToolCallId: "stale-parent",
      }),
      event.reasoningCompleted({
        createdAt: 4_000,
        itemId: "reasoning-1",
        parentToolCallId: "stale-parent",
        text: "Checked effective scope.",
      }),
      event.turnCompleted({ createdAt: 5_000 }),
    ]);

    const reasoningMessages = timeline.messages.filter(
      (message) =>
        message.kind === "operation" && message.title === "Thought for 2s",
    );
    expect(reasoningMessages).toEqual([
      expect.objectContaining({
        detail: "Checked effective scope.",
        scope: { kind: "turn", turnId: "turn-1" },
      }),
    ]);
    expect(reasoningMessages[0]).not.toHaveProperty("parentToolCallId");
  });

  it("finalizes streamed reasoning as interrupted when its turn fails", () => {
    const event = createTimelineEventFactory({ threadId: "thread-1" });
    const timeline = renderIdleTimeline([
      event.turnStarted({ createdAt: 0 }),
      event.reasoningDelta({
        createdAt: 2_000,
        itemId: "reasoning-1",
        delta: "Checking the failure path.",
      }),
      event.turnCompleted({ createdAt: 7_000, status: "failed" }),
    ]);

    expect(
      timeline.messages.filter((message) => message.kind === "operation"),
    ).toEqual([
      expect.objectContaining({
        completedAt: 7_000,
        detail: "Checking the failure path.",
        sourceSeqEnd: 3,
        sourceSeqStart: 2,
        startedAt: 2_000,
        status: "interrupted",
        title: "Thought for 5s",
      }),
    ]);
  });

  it("truncates very long completed reasoning detail", () => {
    const event = createTimelineEventFactory({ threadId: "thread-1" });
    const timeline = renderIdleTimeline([
      event.turnStarted({ createdAt: 0 }),
      event.reasoningStarted({
        createdAt: 1_000,
        itemId: "reasoning-1",
      }),
      event.reasoningCompleted({
        createdAt: 4_000,
        itemId: "reasoning-1",
        text: "x".repeat(40_000),
      }),
      event.turnCompleted({ createdAt: 7_000 }),
    ]);

    const rows = timeline.messages.filter(
      (message) => message.kind === "operation",
    );
    expect(rows).toHaveLength(1);
    const detail = (rows[0] as { detail: string }).detail;
    expect(detail).toContain("more characters truncated");
    expect(detail.startsWith("x".repeat(32_000))).toBe(true);
    expect(detail.length).toBeLessThan(40_000);
  });

  it("finalizes streamed reasoning as interrupted when its turn is interrupted", () => {
    const event = createTimelineEventFactory({ threadId: "thread-1" });
    const timeline = renderIdleTimeline([
      event.turnStarted({ createdAt: 0 }),
      event.reasoningDelta({
        createdAt: 2_000,
        itemId: "reasoning-1",
        delta: "Checking the failure path.",
      }),
      event.turnCompleted({ createdAt: 7_000, status: "interrupted" }),
    ]);

    expect(
      timeline.messages.filter((message) => message.kind === "operation"),
    ).toEqual([
      expect.objectContaining({
        completedAt: 7_000,
        detail: "Checking the failure path.",
        sourceSeqEnd: 3,
        sourceSeqStart: 2,
        startedAt: 2_000,
        status: "interrupted",
        title: "Thought for 5s",
      }),
    ]);
  });

  it("ignores reasoning deltas after explicit completion", () => {
    const event = createTimelineEventFactory({ threadId: "thread-1" });
    const timeline = renderActiveTimeline([
      event.turnStarted({ createdAt: 0 }),
      event.reasoningDelta({
        createdAt: 1_000,
        itemId: "reasoning-1",
        delta: "Initial thought.",
      }),
      event.reasoningCompleted({
        createdAt: 3_000,
        itemId: "reasoning-1",
        text: "Final thought.",
      }),
      event.reasoningDelta({
        createdAt: 5_000,
        itemId: "reasoning-1",
        delta: "Late duplicate.",
      }),
    ]);

    expect(timeline.projection.state.activeThinking).toBeNull();
    expect(
      timeline.messages.filter((message) => message.kind === "operation"),
    ).toEqual([
      expect.objectContaining({
        detail: "Final thought.",
        sourceSeqEnd: 3,
        status: "completed",
        title: "Thought for 2s",
      }),
    ]);
  });

  it("accepts the final text after fallback completion without reopening thinking", () => {
    const event = createTimelineEventFactory({ threadId: "thread-1" });
    const timeline = renderActiveTimeline([
      event.turnStarted({ createdAt: 0 }),
      event.reasoningDelta({
        createdAt: 1_000,
        itemId: "reasoning-1",
        delta: "Initial thought.",
      }),
      event.turnCompleted({ createdAt: 3_000, status: "interrupted" }),
      event.reasoningDelta({
        createdAt: 4_000,
        itemId: "reasoning-1",
        delta: "Late delta.",
      }),
      event.reasoningCompleted({
        createdAt: 5_000,
        itemId: "reasoning-1",
        text: "Final thought.",
      }),
      event.reasoningCompleted({
        createdAt: 6_000,
        itemId: "reasoning-1",
        text: "Duplicate completion.",
      }),
    ]);

    expect(timeline.projection.state.activeThinking).toBeNull();
    expect(
      timeline.messages.filter((message) => message.kind === "operation"),
    ).toEqual([
      expect.objectContaining({
        detail: "Final thought.",
        startedAt: 1_000,
        completedAt: 3_000,
        sourceSeqStart: 2,
        sourceSeqEnd: 5,
        status: "interrupted",
        title: "Thought for 2s",
      }),
    ]);
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

  it("projects a persisted codex plan notification as a plan-steps row beside the work", () => {
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
      "plan-steps",
      "web-search",
      "file-edit",
      "assistant-text",
    ]);
    const planRow = flattenTimelineRows(timeline.rows).find(
      (row) => row.kind === "work" && row.workKind === "plan-steps",
    );
    expect(planRow).toMatchObject({
      kind: "work",
      workKind: "plan-steps",
      status: "completed",
      steps: [
        { step: "Read the route", status: "completed" },
        { step: "Patch the projection", status: "active" },
        { step: "Run focused tests", status: "pending" },
      ],
    });
    expect(planRow).not.toHaveProperty("presentation");
    expect(timeline.pendingTodos?.items.map((item) => item.text)).toEqual([
      "Read the route",
      "Patch the projection",
      "Run focused tests",
    ]);
    expect(timeline.text).toContain("Updated plan Patch the projection");
    expect(timeline.text).toContain("Ran web search: React suspense docs");
    expect(timeline.text).toContain(
      "Edited /repo/packages/core-ui/src/timeline.ts +1 -1",
    );
  });

  it("summarizes completed web search and fetch rows without expanding result text", () => {
    const event = createTimelineEventFactory({ threadId: "thread-1" });
    const timeline = renderIdleTimeline([
      event.turnStarted(),
      event.webSearchCompleted({
        itemId: "web-search-1",
        queries: ["EyeDropper API browser compatibility"],
        resultText:
          "Large search result payload that should stay out of the summary.",
      }),
      event.webFetchCompleted({
        itemId: "web-fetch-1",
        url: "https://developer.mozilla.org/en-US/docs/Web/API/EyeDropper_API",
        resultText:
          "Large MDN page payload that should stay out of the summary.",
      }),
      event.webFetchCompleted({
        itemId: "web-fetch-2",
        url: "https://caniuse.com/mdn-api_eyedropper",
        resultText:
          "Large caniuse page payload that should stay out of the summary.",
      }),
      event.assistantCompleted({
        itemId: "assistant-1",
        text: "Done.",
      }),
      event.turnCompleted(),
    ]);

    expect(timeline.text).not.toContain("Large search result payload");
    expect(timeline.text).not.toContain("Large MDN page payload");
    const webRows = flattenTimelineRows(timeline.rows).filter(
      isTimelineWebWorkRow,
    );
    expect(webRows).toHaveLength(3);
    for (const row of webRows) {
      expect(row).not.toHaveProperty("resultText");
    }
    expect(timeline.text).toMatchInlineSnapshot(`
      "── Worked for (5ms) ────────────────────────────────────────
        ── Researched 1 search query, 2 web pages
          ── Ran web search: EyeDropper API browser compatibility
          ── Fetched: https://developer.mozilla.org/en-US/docs/Web/API/EyeDropper_API
          ── Fetched: https://caniuse.com/mdn-api_eyedropper

      ── Assistant ───────────────────────────────────────────────
      Done."
    `);
  });

  it("summarizes active web search and fetch rows without expanding result text", () => {
    const event = createTimelineEventFactory({ threadId: "thread-1" });
    const timeline = renderActiveTimeline([
      event.turnStarted(),
      event.webSearchStarted({
        itemId: "web-search-1",
        queries: ["React Suspense docs"],
        resultText:
          "Streaming search payload that should stay out of the summary.",
      }),
      event.webFetchStarted({
        itemId: "web-fetch-1",
        url: "https://react.dev/reference/react/Suspense",
        resultText:
          "Streaming fetch payload that should stay out of the summary.",
      }),
    ]);

    expect(timeline.text).not.toContain("Streaming search payload");
    expect(timeline.text).not.toContain("Streaming fetch payload");
    expect(timeline.text).toMatchInlineSnapshot(`
      "── Researching 1 search query, 1 web page ──────────────────
        ── Running web search: React Suspense docs
        ── Fetching: https://react.dev/reference/react/Suspense"
    `);
  });

  it("omits direct active web result text even in verbose output", () => {
    const event = createTimelineEventFactory({ threadId: "thread-1" });
    const searchTimeline = renderActiveTimeline([
      event.turnStarted(),
      event.webSearchStarted({
        itemId: "web-search-1",
        queries: ["React Suspense docs"],
        resultText:
          "Direct search payload that should not be exposed in verbose output.",
      }),
    ]);
    const fetchTimeline = renderActiveTimeline([
      event.turnStarted(),
      event.webFetchStarted({
        itemId: "web-fetch-1",
        url: "https://react.dev/reference/react/Suspense",
        resultText:
          "Direct fetch payload that should not be exposed in verbose output.",
      }),
    ]);

    expect(searchTimeline.text).not.toContain("Direct search payload");
    expect(fetchTimeline.text).not.toContain("Direct fetch payload");
    const searchRow = getOnlyTimelineWebWorkRow(searchTimeline.rows);
    const fetchRow = getOnlyTimelineWebWorkRow(fetchTimeline.rows);
    expect(searchRow).toMatchObject({ workKind: "web-search" });
    expect(fetchRow).toMatchObject({ workKind: "web-fetch" });
    expect(searchRow).not.toHaveProperty("resultText");
    expect(fetchRow).not.toHaveProperty("resultText");
  });

  it("capitalizes fetch-only web summaries", () => {
    const event = createTimelineEventFactory({ threadId: "thread-1" });
    const timeline = renderIdleTimeline([
      event.turnStarted(),
      event.webFetchCompleted({
        itemId: "web-fetch-1",
        url: "https://example.com/page",
        resultText: "Fetched page payload that should stay out of the summary.",
      }),
      event.turnCompleted(),
    ]);

    expect(timeline.text).not.toContain("Fetched page payload");
    expect(timeline.text).toMatchInlineSnapshot(`
      "── Worked for (2ms) ────────────────────────────────────────
        ── Fetched: https://example.com/page"
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
      "command",
    ]);
    expect(timeline.text).toMatchInlineSnapshot(`
      "── Waiting for permission to use Bash ──────────────────────

      ── Permission denied: git push ─────────────────────────────
        $ git push"
    `);
  });

  it("keeps failed command titles in the normal command title style", () => {
    const event = createTimelineEventFactory({ threadId: "thread-1" });
    const timeline = renderActiveTimeline([
      event.turnStarted({ createdAt: 1 }),
      event.commandStarted({
        itemId: "call-failed",
        command: "pnpm test",
        createdAt: 1,
      }),
      event.commandCompleted({
        itemId: "call-failed",
        command: "pnpm test",
        status: "failed",
        aggregatedOutput: "Tests failed\n",
        exitCode: 1,
        createdAt: 2001,
      }),
    ]);

    expect(timeline.text).toMatchInlineSnapshot(`
      "── Ran pnpm test (2s, error) ───────────────────────────────
        $ pnpm test
        Tests failed
        exit 1"
    `);

    const coloredText = formatThreadTimelineText(timeline.rows, {
      color: true,
      verbose: true,
    });
    expect(coloredText).toContain("exit 1");
    expect(coloredText).not.toContain("\u001B[31m");
  });

  it("keeps zero exit code visible when a completed command has no output", () => {
    const event = createTimelineEventFactory({ threadId: "thread-1" });
    const timeline = renderActiveTimeline([
      event.turnStarted({ createdAt: 1 }),
      event.commandStarted({
        itemId: "call-empty-success",
        command:
          "pnpm exec turbo run typecheck --filter=@bb/app > /tmp/typecheck.txt 2>&1",
        createdAt: 1,
      }),
      event.commandCompleted({
        itemId: "call-empty-success",
        command:
          "pnpm exec turbo run typecheck --filter=@bb/app > /tmp/typecheck.txt 2>&1",
        aggregatedOutput: "",
        exitCode: 0,
        createdAt: 4001,
      }),
    ]);

    expect(timeline.text).toMatchInlineSnapshot(`
      "── Ran pnpm exec turbo run typecheck --filter=@bb/app > /tmp/typecheck.txt 2>&1 (4s)
        $ pnpm exec turbo run typecheck --filter=@bb/app > /tmp/typecheck.txt 2>&1
        exit code 0"
    `);
  });

  it("shows legacy visible system assistant text and user-message tool output in the regular timeline", () => {
    const event = createTimelineEventFactory({
      threadId: "legacy-thread-1",
      turnId: "turn-1",
    });
    const timeline = renderTimelineFixture({
      events: [
        event.turnStarted(),
        event.assistantCompleted({
          itemId: "assistant-1",
          text: "internal system chatter",
        }),
        event.legacyUserMessage({ text: "Visible legacy update" }),
      ],
      projectionOptions: {
        threadStatus: "idle",
        turnMessageDetail: "summary",
      },
    });

    expect(messageKinds(timeline.messages)).toEqual([
      "assistant-text",
      "assistant-text",
    ]);
    expect(timeline.text).toMatchInlineSnapshot(`
      "── Assistant ───────────────────────────────────────────────
      internal system chatter

      ── Assistant ───────────────────────────────────────────────
      Visible legacy update"
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
      "── Reconnecting... 2/3 ─────────────────────────────────────

      ── Error ───────────────────────────────────────────────────
        Provider runtime is unavailable"
    `);
  });
});
