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

describe("timeline CLI rendering snapshots", () => {
  it("truncates audit output only inside conversation and leaf row bodies", () => {
    const event = createTimelineEventFactory({ threadId: "thread-1" });
    const longUserLine = `User message ${"body ".repeat(30).trimEnd()}`;
    const longSearchPattern = "timeline".repeat(18);
    const commandOutput = [
      "commit 2bc512e57819f74a07688ac6f49dfc0522c46a1a",
      "Author: OpenAI Codex <codex@openai.com>",
      "",
      "    Remove legacy timeline bundle renderer",
      "",
      " apps/server/test/helpers/timeline-benchmark.ts     |   27 +-",
      " packages/core-ui/src/format-timeline-text.ts       |  779 +-------",
      " packages/core-ui/src/thread-detail-rows.ts         | 1030 ----------",
    ].join("\n");
    const timeline = renderIdleTimeline([
      event.clientTurnRequested({
        target: { kind: "new-turn" },
        text: [
          longUserLine,
          "second user line",
          "third user line",
          "fourth user line",
        ].join("\n"),
      }),
      event.turnStarted(),
      event.commandCompleted({
        itemId: "search-1",
        command: `/bin/zsh -lc 'rg ${longSearchPattern} packages/core-ui'`,
      }),
      event.commandCompleted({
        itemId: "command-1",
        command: "git show 2bc512e57 --stat | head -20",
        aggregatedOutput: commandOutput,
        exitCode: 0,
      }),
      event.turnCompleted(),
    ]);

    const auditText = formatThreadTimelineText(timeline.rows, {
      color: false,
      truncateForAudit: true,
      verbose: true,
    });

    expect(auditText).toContain(
      `${longUserLine.slice(0, 100)}... [truncated ${longUserLine.length - 100} chars]`,
    );
    expect(auditText).toContain("... [truncated 1 lines]");
    expect(auditText).toContain(
      `── Searched for ${longSearchPattern} in packages/core-ui`,
    );
    expect(auditText).toContain("      ... [truncated 6 lines]");
    expect(auditText).not.toContain("Remove legacy timeline bundle renderer");
    expect(auditText).not.toContain(
      "packages/core-ui/src/thread-detail-rows.ts",
    );
    expect(auditText).toMatchInlineSnapshot(`
      "── User ────────────────────────────────────────────────────
      User message body body body body body body body body body body body body body body body body body bo... [truncated 62 chars]
      second user line
      third user line
      ... [truncated 1 lines]

      ── Worked on 2 items ───────────────────────────────────────
        ── Explored 1 search, ran 1 command
          ── Searched for timelinetimelinetimelinetimelinetimelinetimelinetimelinetimelinetimelinetimelinetimelinetimelinetimelinetimelinetimelinetimelinetimelinetimeline in packages/core-ui
          ── Ran command (completed)
            $ git show 2bc512e57 --stat | head -20
            commit 2bc512e57819f74a07688ac6f49dfc0522c46a1a
            Author: OpenAI Codex <codex@openai.com>
             ... [truncated 6 lines]"
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

      ── Exploring 1 search ──────────────────────────────────────
        ── Searched for timeline in packages/core-ui",
        },
        {
          "messageKinds": [
            "user",
            "command",
          ],
          "prefixLength": 5,
          "text": "── User ────────────────────────────────────────────────────
      Patch the timeline output

      ── Explored 1 search ───────────────────────────────────────
        ── Searched for timeline in packages/core-ui",
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

      ── Working on 3 items ──────────────────────────────────────
        ── Searched for timeline in packages/core-ui
        ── Ran web search: timeline rendering
        ── Editing format-timeline-text.ts",
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

      ── Worked on 3 items ───────────────────────────────────────
        ── Explored 1 search, ran 1 web search, edited 1 file
          ── Searched for timeline in packages/core-ui
          ── Ran web search: timeline rendering
          ── Edited format-timeline-text.ts +1 -1
            @@ -1 +1 @@
            -before
            +after

      ── Assistant ───────────────────────────────────────────────
      Updated the timeline output.",
        },
      ]
    `);
  });

  it("shows an unacknowledged active-turn steer from the client request", () => {
    const event = createTimelineEventFactory({ threadId: "thread-1" });
    const timeline = renderIdleTimeline([
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
      "user",
      "command",
      "assistant-text",
    ]);
    const steerMessage = timeline.messages.find(
      (message) => message.kind === "user",
    );
    expect(steerMessage?.sourceSeqStart).toBe(3);
    expect(timeline.text).toMatchInlineSnapshot(`
      "── Worked on 2 items ───────────────────────────────────────
        ── Ran 1 command
          ── Ran command (completed)
            $ pnpm test

        ── User
        Please account for the restart

        ── Ran 1 command
          ── Ran command (completed)
            $ sqlite3 ~/.bb-dev/bb.db '.tables'

      ── Assistant ───────────────────────────────────────────────
      Done."
    `);
  });

  it("uses active-turn input acceptance only as request correlation", () => {
    const event = createTimelineEventFactory({ threadId: "thread-1" });
    const timeline = renderIdleTimeline([
      event.turnStarted(),
      event.commandCompleted({
        itemId: "tool-before-steer",
        command: "pnpm test",
      }),
      event.clientTurnRequested({
        target: { kind: "auto", expectedTurnId: "turn-1" },
        text: "Please account for the restart",
      }),
      event.inputAccepted({
        clientRequestSequence: 3,
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
    expect(steerMessage?.sourceSeqStart).toBe(3);
    expect(timeline.text).toMatchInlineSnapshot(`
      "── Worked on 2 items ───────────────────────────────────────
        ── Ran 1 command
          ── Ran command (completed)
            $ pnpm test

        ── User
        Please account for the restart

        ── Ran 1 command
          ── Ran command (completed)
            $ sqlite3 ~/.bb-dev/bb.db '.tables'

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

      ── Provisioning thread failed ──────────────────────────────
        Running setup
        pnpm install failed

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

    expect(timeline.turnRows).toHaveLength(1);
    expect(timeline.turnRows[0]?.summaryCount).toBe(2);
    expect(timeline.text).toMatchInlineSnapshot(`
      "── Worked on 2 items ───────────────────────────────────────
        ── Explored 1 search, ran 1 command
          ── Searched for TODO in packages/core-ui
          ── Ran command (completed)
            $ pnpm test
            Tests passed

      ── Assistant ───────────────────────────────────────────────
      The TODO sweep is clean."
    `);
  });

  it("keeps tool work after terminal assistant output visible", () => {
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
    expect(timeline.turnRows[0]?.summaryCount).toBe(1);
    expect(timeline.text).toMatchInlineSnapshot(`
      "── Worked on 1 item ────────────────────────────────────────
        ── Ran 1 command
          ── Ran command (completed)
            $ pnpm test
            Tests passed

      ── Assistant ───────────────────────────────────────────────
      I found the test path.

      ── Explored 1 search ───────────────────────────────────────
        ── Searched for setState in packages/excalidraw/tests/helpers/ui.ts"
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
      event.toolCallCompleted({
        itemId: "delegation-1",
        tool: "spawnAgent",
        arguments: {
          prompt: "Review the branch",
          receiverThreadIds: ["child-provider"],
        },
        result: "Child result",
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
      (row): row is Extract<
        TimelineRow,
        { kind: "work"; workKind: "delegation" }
      > => row.kind === "work" && row.workKind === "delegation",
    );
    const nestedTurn = delegation?.childRows.find(
      (row): row is Extract<TimelineRow, { kind: "turn" }> =>
        row.kind === "turn",
    );

    expect(rootTurn).toBeDefined();
    expect(delegation).toBeDefined();
    expect(nestedTurn).toBeDefined();
    expect(nestedTurn?.id).toBe(
      `${delegation?.id}:child:thread-1:turn-1:turn`,
    );
    expect(nestedTurn?.id).not.toBe(rootTurn?.id);
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
      "── Worked on 5 items ───────────────────────────────────────
        ── Explored 1 file, 1 search, 2 lists
          ── Read a.ts
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
      "── Worked on 4 items ───────────────────────────────────────
        ── Created 1 file, deleted 1 file, edited 2 files
          ── Created a.ts +1
            @@ -0,0 +1 @@
            +first
          ── Edited a.ts +1 -1
            @@ -1 +1 @@
            -first
            +second
          ── Edited b.ts +1 -1
            @@ -1 +1 @@
            -before
            +after
          ── Deleted c.ts -1
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
      "── Worked on 2 items ───────────────────────────────────────
        ── Created 1 file, deleted 1 file
          ── Created created.ts +2
            first line
            second line
          ── Deleted deleted.ts -2
            old first
            old second"
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

    expect(timeline.turnRows).toHaveLength(1);
    expect(timeline.turnRows[0]?.summaryCount).toBe(1);
    expect(timeline.text).not.toContain("Reasoning");
    expect(timeline.text).toMatchInlineSnapshot(`
      "── Worked on 1 item ────────────────────────────────────────
        ── Ran 1 tool
          ── Ran tool: exec_command { cmd: sed -n '1,80p' packages/core-ui/src/i... }

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

  it("shows web search, file edit, and assistant output without task updates", () => {
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
      "web-search",
      "file-edit",
      "assistant-text",
    ]);
    expect(timeline.text).toMatchInlineSnapshot(`
      "── Ran 1 web search, edited 1 file ─────────────────────────
        ── Ran web search: React suspense docs
        ── Edited timeline.ts +1 -1
          @@ -1 +1 @@
          -before
          +after

      ── Assistant ───────────────────────────────────────────────
      I patched the projection and verified it."
    `);
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
    expect(timeline.text).toMatchInlineSnapshot(`
      "── Worked on 3 items ───────────────────────────────────────
        ── Ran 1 web search, fetched 2 web pages
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
      "── Running 1 web search, fetching 1 web page ───────────────
        ── Running web search: React Suspense docs
        ── Fetching: https://react.dev/reference/react/Suspense"
    `);
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
      "── Worked on 1 item ────────────────────────────────────────
        ── Fetched 1 web page
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
      "── Waiting for approval to grant Bash ──────────────────────

      ── Denied 1 command ────────────────────────────────────────
        ── Command (denied)
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
      "── Ran 1 command ───────────────────────────────────────────
        ── Ran command 2s
          $ pnpm test
          Tests failed
          exit 1"
    `);
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
      "── Ran 1 command ───────────────────────────────────────────
        ── Ran command (completed, 4s)
          $ pnpm exec turbo run typecheck --filter=@bb/app > /tmp/typecheck.txt 2>&1
          exit code 0"
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
      "── Reconnecting... 2/3 ─────────────────────────────────────

      ── Error ───────────────────────────────────────────────────
        Provider runtime is unavailable"
    `);
  });
});
