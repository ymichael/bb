import { describe, expect, it } from "vitest";
import {
  encodeClientTurnRequestIdNumber,
  threadScope,
  turnScope,
} from "@bb/domain";
import type { ClientTurnRequestId, Thread } from "@bb/domain";
import {
  createConnection,
  createProject,
  createThread,
  getLatestThreadSequence,
  insertEvents,
  migrate,
  noopNotifier,
  upsertHost,
} from "@bb/db";
import { LOCAL_WORKFLOW_TASK_TYPE } from "@bb/domain";
import type { DbConnection } from "@bb/db";
import type {
  TimelinePaginationCursor,
  TimelineRow,
} from "@bb/server-contract";
import {
  buildThreadTimeline,
  buildTimelineTurnSummaryDetails,
  buildThreadTimelineWithProfile,
  THREAD_TIMELINE_EVENT_DATA_BYTE_LIMIT,
} from "../../../src/services/threads/timeline.js";

const LARGE_BUDGET = 1_000_000;
const BYTE_WINDOW_ITEM_COUNT = 250;

const providerThreadId = "provider-root";
const execution = {
  model: "gpt-5",
  serviceTier: "default",
  reasoningLevel: "medium",
  permissionMode: "full",
  source: "client/turn/requested",
} as const;

function requestId(value: number): ClientTurnRequestId {
  return encodeClientTurnRequestIdNumber({ value });
}

function setup(): { db: DbConnection; thread: Thread } {
  const db = createConnection(":memory:");
  migrate(db);
  const host = upsertHost(db, noopNotifier, {
    name: "test-host",
    type: "persistent",
  });
  const { project } = createProject(db, noopNotifier, {
    name: "test-project",
    source: { type: "local_path", hostId: host.id, path: "/tmp/test" },
  });
  const thread = createThread(db, noopNotifier, {
    projectId: project.id,
    providerId: "claude-code",
  });
  return { db, thread };
}

type EventInput = Parameters<typeof insertEvents>[2][number];

const BACKGROUND_TASK_ITEM_ID = "task:wf-1";

function backgroundTaskData(status: "pending" | "completed"): string {
  return JSON.stringify({
    providerThreadId,
    item: {
      type: "backgroundTask",
      id: BACKGROUND_TASK_ITEM_ID,
      taskType: LOCAL_WORKFLOW_TASK_TYPE,
      description: "long workflow",
      status,
      taskStatus: status === "pending" ? "running" : "completed",
      skipTranscript: false,
      workflowName: "long-workflow",
    },
  });
}

interface SeedOptions {
  backgroundTask?: "open" | "completed";
  delegateLastTurn?: boolean;
  completeLastTurn: boolean;
  commandChars?: number;
  longRunningItemIndexes?: readonly number[];
  outputChars?: number;
  streamLongRunningOutput?: boolean;
  itemsPerTurn: readonly number[];
}

function seedTurns(
  db: DbConnection,
  thread: Thread,
  options: SeedOptions,
): void {
  const events: EventInput[] = [];
  let sequence = 0;
  const push = (event: Omit<EventInput, "sequence" | "threadId">): void => {
    sequence += 1;
    events.push({ ...event, sequence, threadId: thread.id });
  };

  options.itemsPerTurn.forEach((items, index) => {
    const turn = index + 1;
    const isLastTurn = turn === options.itemsPerTurn.length;
    const turnId = `turn-${turn}`;
    const clientRequestId = requestId(turn);
    push({
      type: "client/turn/requested",
      scope: threadScope(),
      itemId: null,
      itemKind: null,
      parentToolCallId: null,
      data: JSON.stringify({
        direction: "outbound",
        source: "tell",
        initiator: "user",
        request: { method: "turn/start", params: {} },
        requestId: clientRequestId,
        senderThreadId: null,
        input: [{ type: "text", text: `User message ${turn}`, mentions: [] }],
        target: turn === 1 ? { kind: "thread-start" } : { kind: "new-turn" },
        execution,
      }),
    });
    push({
      type: "turn/started",
      scope: turnScope(turnId),
      providerThreadId,
      itemId: null,
      itemKind: null,
      parentToolCallId: null,
      data: JSON.stringify({}),
    });
    push({
      type: "turn/input/accepted",
      scope: turnScope(turnId),
      providerThreadId,
      itemId: null,
      itemKind: null,
      parentToolCallId: null,
      data: JSON.stringify({ clientRequestId }),
    });

    if (isLastTurn && options.backgroundTask !== undefined) {
      push({
        type: "item/started",
        scope: turnScope(turnId),
        providerThreadId,
        itemId: BACKGROUND_TASK_ITEM_ID,
        itemKind: "backgroundTask",
        parentToolCallId: null,
        data: backgroundTaskData("pending"),
      });
      if (options.backgroundTask === "completed") {
        push({
          type: "item/backgroundTask/completed",
          scope: threadScope(),
          providerThreadId,
          itemId: BACKGROUND_TASK_ITEM_ID,
          itemKind: "backgroundTask",
          parentToolCallId: null,
          data: backgroundTaskData("completed"),
        });
      }
    }

    const parentToolCallId =
      isLastTurn && options.delegateLastTurn ? `${turnId}-delegate` : null;
    if (parentToolCallId !== null) {
      push({
        type: "item/started",
        scope: turnScope(turnId),
        providerThreadId,
        itemId: parentToolCallId,
        itemKind: "toolCall",
        parentToolCallId: null,
        data: JSON.stringify({
          item: {
            type: "toolCall",
            id: parentToolCallId,
            tool: "Agent",
            arguments: { prompt: "Do the long task." },
            status: "pending",
          },
        }),
      });
    }

    const longRunning = new Set(
      isLastTurn ? (options.longRunningItemIndexes ?? []) : [],
    );
    const deferred: number[] = [];
    for (let item = 0; item < items; item += 1) {
      const itemId = `${turnId}-item-${item}`;
      const command =
        options.commandChars === undefined
          ? `echo ${item}`
          : "x".repeat(options.commandChars);
      push({
        type: "item/started",
        scope: turnScope(turnId),
        providerThreadId,
        itemId,
        itemKind: "commandExecution",
        parentToolCallId,
        data: JSON.stringify({
          item: {
            type: "commandExecution",
            id: itemId,
            command,
            cwd: "/tmp/test",
            ...(parentToolCallId === null ? {} : { parentToolCallId }),
            status: "pending",
            approvalStatus: null,
          },
        }),
      });
      if (longRunning.has(item)) {
        deferred.push(item);
        continue;
      }
      for (const streaming of deferred) {
        if (!options.streamLongRunningOutput) {
          break;
        }
        push({
          type: "item/commandExecution/outputDelta",
          scope: turnScope(turnId),
          providerThreadId,
          itemId: `${turnId}-item-${streaming}`,
          itemKind: null,
          parentToolCallId: null,
          data: JSON.stringify({
            threadId: thread.id,
            providerThreadId,
            itemId: `${turnId}-item-${streaming}`,
            delta: `tick ${item}\n`,
          }),
        });
      }
      push({
        type: "item/completed",
        scope: turnScope(turnId),
        providerThreadId,
        itemId,
        itemKind: "commandExecution",
        parentToolCallId,
        data: JSON.stringify({
          item: {
            type: "commandExecution",
            id: itemId,
            command,
            cwd: "/tmp/test",
            ...(parentToolCallId === null ? {} : { parentToolCallId }),
            status: "completed",
            approvalStatus: null,
            exitCode: 0,
            aggregatedOutput:
              options.outputChars === undefined
                ? `output ${item}`
                : "o".repeat(options.outputChars),
          },
        }),
      });
    }
    for (const item of deferred) {
      const itemId = `${turnId}-item-${item}`;
      push({
        type: "item/completed",
        scope: turnScope(turnId),
        providerThreadId,
        itemId,
        itemKind: "commandExecution",
        parentToolCallId,
        data: JSON.stringify({
          item: {
            type: "commandExecution",
            id: itemId,
            command:
              options.commandChars === undefined
                ? `echo ${item}`
                : "x".repeat(options.commandChars),
            cwd: "/tmp/test",
            ...(parentToolCallId === null ? {} : { parentToolCallId }),
            status: "completed",
            approvalStatus: null,
            exitCode: 0,
            aggregatedOutput:
              options.outputChars === undefined
                ? `late output ${item}`
                : "o".repeat(options.outputChars),
          },
        }),
      });
    }

    if (parentToolCallId !== null) {
      push({
        type: "item/completed",
        scope: turnScope(turnId),
        providerThreadId,
        itemId: parentToolCallId,
        itemKind: "toolCall",
        parentToolCallId: null,
        data: JSON.stringify({
          item: {
            type: "toolCall",
            id: parentToolCallId,
            tool: "Agent",
            arguments: { prompt: "Do the long task." },
            result: "",
            status: "completed",
          },
        }),
      });
    }

    if (!isLastTurn || options.completeLastTurn) {
      push({
        type: "turn/completed",
        scope: turnScope(turnId),
        providerThreadId,
        itemId: null,
        itemKind: null,
        parentToolCallId: null,
        data: JSON.stringify({ status: "completed", providerThreadId }),
      });
    }
  });

  insertEvents(db, noopNotifier, events);
}

function appendCommandItems(
  db: DbConnection,
  thread: Thread,
  args: { commandChars: number; count: number; itemStart: number },
): void {
  let sequence = getLatestThreadSequence(db, { threadId: thread.id });
  const events: EventInput[] = [];
  const push = (event: Omit<EventInput, "sequence" | "threadId">): void => {
    sequence += 1;
    events.push({ ...event, sequence, threadId: thread.id });
  };
  for (let offset = 0; offset < args.count; offset += 1) {
    const item = args.itemStart + offset;
    const itemId = `turn-1-item-${item}`;
    const command = "x".repeat(args.commandChars);
    push({
      type: "item/started",
      scope: turnScope("turn-1"),
      providerThreadId,
      itemId,
      itemKind: "commandExecution",
      parentToolCallId: null,
      data: JSON.stringify({
        item: {
          type: "commandExecution",
          id: itemId,
          command,
          cwd: "/tmp/test",
          status: "pending",
          approvalStatus: null,
        },
      }),
    });
    push({
      type: "item/completed",
      scope: turnScope("turn-1"),
      providerThreadId,
      itemId,
      itemKind: "commandExecution",
      parentToolCallId: null,
      data: JSON.stringify({
        item: {
          type: "commandExecution",
          id: itemId,
          command,
          cwd: "/tmp/test",
          status: "completed",
          approvalStatus: null,
          exitCode: 0,
          aggregatedOutput: `output ${item}`,
        },
      }),
    });
  }
  insertEvents(db, noopNotifier, events);
}

function buildPage(
  db: DbConnection,
  thread: Thread,
  eventBudget: number,
  cursor: TimelinePaginationCursor | null,
  segmentLimit = 20,
) {
  return buildThreadTimelineWithProfile(db, thread, {
    eventBudget,
    includeProviderUnhandledOperations: false,
    includeNestedRows: false,
    maxInlineOutputChars: 32_000,
    maxSeq: 0,
    page: cursor
      ? { kind: "older", beforeCursor: cursor, segmentLimit }
      : { kind: "latest", segmentLimit },
  });
}

function buildNestedPage(
  db: DbConnection,
  thread: Thread,
  eventBudget: number,
  cursor: TimelinePaginationCursor | null,
) {
  return buildThreadTimelineWithProfile(db, thread, {
    eventBudget,
    includeProviderUnhandledOperations: false,
    includeNestedRows: true,
    maxInlineOutputChars: 32_000,
    maxSeq: 0,
    page: cursor
      ? { kind: "older", beforeCursor: cursor, segmentLimit: 20 }
      : { kind: "latest", segmentLimit: 20 },
  });
}

function collectCommandCallIds(
  rows: readonly TimelineRow[],
  target: Set<string>,
): void {
  for (const row of rows) {
    if (row.kind === "work" && row.workKind === "command") {
      target.add(row.callId);
    }
    if (row.kind === "work" && row.workKind === "delegation") {
      collectCommandCallIds(row.childRows, target);
    }
    if (row.kind === "turn" && row.children !== null) {
      collectCommandCallIds(row.children, target);
    }
  }
}

interface WalkResult {
  maxEventRowCount: number;
  pages: number;
  rows: string[];
}

function walkAllPages(
  db: DbConnection,
  thread: Thread,
  eventBudget: number,
): WalkResult {
  const rowsByPage: string[][] = [];
  const seenCursors = new Set<string>();
  let cursor: TimelinePaginationCursor | null = null;
  let maxEventRowCount = 0;
  let pages = 0;

  for (;;) {
    const { profile, response } = buildPage(db, thread, eventBudget, cursor);
    pages += 1;
    maxEventRowCount = Math.max(maxEventRowCount, profile.eventRowCount);
    rowsByPage.push(response.rows.map((row) => JSON.stringify(row)));
    if (!response.timelinePage.hasOlderRows) {
      break;
    }
    const next = response.timelinePage.olderCursor;
    expect(
      next,
      `page ${pages} claimed older rows with no cursor`,
    ).not.toBeNull();
    const key = `${next!.anchorSeq}:${next!.anchorId}`;
    expect(seenCursors.has(key), `cursor loop at ${key}`).toBe(false);
    seenCursors.add(key);
    cursor = next;
    expect(pages).toBeLessThan(100);
  }

  return { maxEventRowCount, pages, rows: rowsByPage.reverse().flat() };
}

describe("in-turn timeline windows", () => {
  const expectSteerDetailsOwnership = (
    steerStatus: "accepted" | "rejected",
  ): void => {
    const { db, thread } = setup();
    const initialRequestId = requestId(1);
    const steerRequestId = requestId(2);
    const turnId = "turn-1";
    const commandId = "command-1";
    const steerTerminalEvent: EventInput =
      steerStatus === "accepted"
        ? {
            threadId: thread.id,
            sequence: 6,
            type: "turn/input/accepted",
            scope: turnScope(turnId),
            providerThreadId,
            itemId: null,
            itemKind: null,
            parentToolCallId: null,
            data: JSON.stringify({ clientRequestId: steerRequestId }),
          }
        : {
            threadId: thread.id,
            sequence: 6,
            type: "client/turn/rejected",
            scope: threadScope(),
            itemId: null,
            itemKind: null,
            parentToolCallId: null,
            data: JSON.stringify({
              requestId: steerRequestId,
              reason: "command_failed",
              message: "The steer was rejected",
            }),
          };

    insertEvents(db, noopNotifier, [
      {
        threadId: thread.id,
        sequence: 1,
        type: "client/turn/requested",
        scope: threadScope(),
        itemId: null,
        itemKind: null,
        parentToolCallId: null,
        data: JSON.stringify({
          direction: "outbound",
          source: "tell",
          initiator: "user",
          request: { method: "turn/start", params: {} },
          requestId: initialRequestId,
          senderThreadId: null,
          input: [{ type: "text", text: "Run the command", mentions: [] }],
          target: { kind: "thread-start" },
          execution,
        }),
      },
      {
        threadId: thread.id,
        sequence: 2,
        type: "turn/started",
        scope: turnScope(turnId),
        providerThreadId,
        itemId: null,
        itemKind: null,
        parentToolCallId: null,
        data: JSON.stringify({}),
      },
      {
        threadId: thread.id,
        sequence: 3,
        type: "turn/input/accepted",
        scope: turnScope(turnId),
        providerThreadId,
        itemId: null,
        itemKind: null,
        parentToolCallId: null,
        data: JSON.stringify({ clientRequestId: initialRequestId }),
      },
      {
        threadId: thread.id,
        sequence: 4,
        type: "item/started",
        scope: turnScope(turnId),
        providerThreadId,
        itemId: commandId,
        itemKind: "commandExecution",
        parentToolCallId: null,
        data: JSON.stringify({
          item: {
            type: "commandExecution",
            id: commandId,
            command: "sleep 20",
            cwd: "/tmp/test",
            status: "pending",
            approvalStatus: null,
          },
        }),
      },
      {
        threadId: thread.id,
        sequence: 5,
        type: "client/turn/requested",
        scope: threadScope(),
        itemId: null,
        itemKind: null,
        parentToolCallId: null,
        data: JSON.stringify({
          direction: "outbound",
          source: "tell",
          initiator: "user",
          request: { method: "turn/start", params: {} },
          requestId: steerRequestId,
          senderThreadId: null,
          input: [
            {
              type: "text",
              text: "Stop waiting and answer immediately.",
              mentions: [],
            },
          ],
          target: { kind: "steer", expectedTurnId: turnId },
          execution,
        }),
      },
      steerTerminalEvent,
      {
        threadId: thread.id,
        sequence: 7,
        type: "item/completed",
        scope: turnScope(turnId),
        providerThreadId,
        itemId: commandId,
        itemKind: "commandExecution",
        parentToolCallId: null,
        data: JSON.stringify({
          item: {
            type: "commandExecution",
            id: commandId,
            command: "sleep 20",
            cwd: "/tmp/test",
            status: "completed",
            approvalStatus: null,
            exitCode: 0,
            aggregatedOutput: "",
          },
        }),
      },
      {
        threadId: thread.id,
        sequence: 8,
        type: "turn/completed",
        scope: turnScope(turnId),
        providerThreadId,
        itemId: null,
        itemKind: null,
        parentToolCallId: null,
        data: JSON.stringify({ status: "completed", providerThreadId }),
      },
    ]);

    const timeline = buildPage(db, thread, LARGE_BUDGET, null).response;
    const turnRow = timeline.rows.find(
      (row): row is Extract<TimelineRow, { kind: "turn" }> =>
        row.kind === "turn",
    );
    expect(turnRow).toBeDefined();
    if (!turnRow) {
      throw new Error("expected a turn row");
    }
    const rootSteers = timeline.rows.filter(
      (row) =>
        row.kind === "conversation" &&
        row.role === "user" &&
        row.turnRequest?.kind === "steer",
    );
    expect(rootSteers).toHaveLength(1);
    expect(rootSteers[0]).toMatchObject({
      turnRequest: { kind: "steer", status: steerStatus },
    });

    const details = buildTimelineTurnSummaryDetails(db, thread, {
      includeProviderUnhandledOperations: false,
      sourceSeqEnd: turnRow.sourceSeqEnd,
      sourceSeqStart: turnRow.sourceSeqStart,
      turnId: turnRow.turnId,
    });
    expect(
      details.rows.filter(
        (row) =>
          row.kind === "conversation" &&
          row.role === "user" &&
          row.turnRequest?.kind === "steer",
      ),
    ).toEqual([]);
    expect(
      details.rows.filter(
        (row) => row.kind === "work" && row.workKind === "command",
      ),
    ).toHaveLength(1);
  };

  it("keeps an accepted steer out of details for work that spans it", () => {
    expectSteerDetailsOwnership("accepted");
  });

  it("keeps a rejected steer out of details for work that spans it", () => {
    expectSteerDetailsOwnership("rejected");
  });

  it("bounds a running turn that is larger than the whole budget", () => {
    const { db, thread } = setup();
    seedTurns(db, thread, { completeLastTurn: false, itemsPerTurn: [300] });

    const unbudgeted = buildPage(db, thread, LARGE_BUDGET, null);
    expect(unbudgeted.profile.eventRowCount).toBeGreaterThan(600);
    expect(unbudgeted.response.timelinePage.hasOlderRows).toBe(false);

    const budgeted = buildPage(db, thread, 100, null);
    expect(budgeted.profile.eventRowCount).toBeLessThanOrEqual(120);
    expect(budgeted.response.rows.length).toBeLessThan(
      unbudgeted.response.rows.length,
    );
    expect(budgeted.response.timelinePage.hasOlderRows).toBe(true);
    expect(budgeted.response.timelinePage.olderCursor?.anchorId).toMatch(
      new RegExp(`^${thread.id}:in-turn:\\d+$`),
    );
  });

  it("pages a compact byte slice with hundreds of item identities", () => {
    const { db, thread } = setup();
    seedTurns(db, thread, {
      commandChars: THREAD_TIMELINE_EVENT_DATA_BYTE_LIMIT - 500_000,
      completeLastTurn: false,
      itemsPerTurn: [1],
    });
    appendCommandItems(db, thread, {
      commandChars: 1,
      count: 1_000,
      itemStart: 1,
    });
    insertEvents(db, noopNotifier, [
      {
        threadId: thread.id,
        sequence: getLatestThreadSequence(db, { threadId: thread.id }) + 1,
        type: "turn/completed",
        scope: turnScope("turn-1"),
        providerThreadId,
        itemId: null,
        itemKind: null,
        parentToolCallId: null,
        data: JSON.stringify({ status: "completed", providerThreadId }),
      },
    ]);

    const walked = walkAllPages(db, thread, LARGE_BUDGET);

    expect(walked.pages).toBeGreaterThan(1);
    expect(walked.rows).not.toHaveLength(0);
  });

  it("pages back through a running oversized turn to exactly the unbudgeted rows", () => {
    const { db, thread } = setup();
    seedTurns(db, thread, {
      completeLastTurn: false,
      itemsPerTurn: [20, 30, 300],
    });

    const unbudgeted = walkAllPages(db, thread, LARGE_BUDGET);
    const budgeted = walkAllPages(db, thread, 100);

    expect(budgeted.rows).toEqual(unbudgeted.rows);
    expect(budgeted.pages).toBeGreaterThan(1);
    expect(budgeted.maxEventRowCount).toBeLessThan(
      unbudgeted.maxEventRowCount / 2,
    );
  });

  it("keeps a finished turn whole under the event-count budget", () => {
    const { db, thread } = setup();
    seedTurns(db, thread, { completeLastTurn: true, itemsPerTurn: [300] });

    const budgeted = buildPage(db, thread, 100, null);

    expect(budgeted.response.timelinePage.hasOlderRows).toBe(false);
    expect(budgeted.response.timelinePage.olderCursor).toBeNull();
    expect(budgeted.response.rows).toEqual(
      buildPage(db, thread, LARGE_BUDGET, null).response.rows,
    );
  });

  it("pages through a finished turn that exceeds the event-data byte limit", () => {
    const { db, thread } = setup();
    seedTurns(db, thread, {
      commandChars: 25_000,
      completeLastTurn: true,
      itemsPerTurn: [BYTE_WINDOW_ITEM_COUNT],
    });

    const commandCallIds = new Set<string>();
    const expandedCommandCallIds = new Set<string>();
    const turnRowIds = new Set<string>();
    let cursor: TimelinePaginationCursor | null = null;
    let pages = 0;
    for (;;) {
      const page = buildNestedPage(db, thread, LARGE_BUDGET, cursor);
      pages += 1;
      collectCommandCallIds(page.response.rows, commandCallIds);
      for (const row of page.response.rows) {
        if (row.kind !== "turn") {
          continue;
        }
        expect(row.status).toBe("completed");
        expect(turnRowIds.has(row.id)).toBe(false);
        turnRowIds.add(row.id);
        const details = buildTimelineTurnSummaryDetails(db, thread, {
          includeProviderUnhandledOperations: false,
          sourceSeqEnd: row.sourceSeqEnd,
          sourceSeqStart: row.sourceSeqStart,
          turnId: row.turnId,
        });
        const pageDetailCallIds = new Set<string>();
        collectCommandCallIds(details.rows, pageDetailCallIds);
        expect(pageDetailCallIds.size).toBeGreaterThan(0);
        expect(pageDetailCallIds.size).toBeLessThan(BYTE_WINDOW_ITEM_COUNT);
        for (const callId of pageDetailCallIds) {
          expandedCommandCallIds.add(callId);
        }
      }
      expect(page.profile.eventDataBytes, `page ${pages}`).toBeLessThanOrEqual(
        THREAD_TIMELINE_EVENT_DATA_BYTE_LIMIT,
      );
      if (!page.response.timelinePage.hasOlderRows) {
        break;
      }
      cursor = page.response.timelinePage.olderCursor;
      expect(cursor).not.toBeNull();
      expect(cursor?.anchorId).toContain(":byte-window:");
      expect(pages).toBeLessThan(10);
    }

    expect(pages).toBeGreaterThan(2);
    expect(commandCallIds.size).toBe(BYTE_WINDOW_ITEM_COUNT);
    expect(expandedCommandCallIds.size).toBe(BYTE_WINDOW_ITEM_COUNT);
    expect(turnRowIds.size).toBe(pages);
  }, 15_000);

  it("keeps latest byte-page row identities stable while a turn grows", () => {
    const { db, thread } = setup();
    seedTurns(db, thread, {
      commandChars: 25_000,
      completeLastTurn: false,
      itemsPerTurn: [75],
    });

    const first = buildPage(db, thread, LARGE_BUDGET, null).response;
    appendCommandItems(db, thread, {
      commandChars: 25_000,
      count: 20,
      itemStart: 75,
    });
    const second = buildPage(db, thread, LARGE_BUDGET, null).response;
    appendCommandItems(db, thread, {
      commandChars: 25_000,
      count: 10,
      itemStart: 95,
    });
    const third = buildPage(db, thread, LARGE_BUDGET, null).response;

    expect(first.timelinePage.olderCursor?.anchorSeq).not.toBe(
      second.timelinePage.olderCursor?.anchorSeq,
    );
    expect(second.timelinePage.olderCursor?.anchorSeq).not.toBe(
      third.timelinePage.olderCursor?.anchorSeq,
    );
    for (const [previous, next] of [
      [first, second],
      [second, third],
    ] as const) {
      const previousIdsByCall = new Map(
        previous.rows.flatMap((row) =>
          row.kind === "work" && row.workKind === "command"
            ? [[row.callId, row.id] as const]
            : [],
        ),
      );
      const sharedRows = next.rows.flatMap((row) =>
        row.kind === "work" &&
        row.workKind === "command" &&
        previousIdsByCall.has(row.callId)
          ? [[row.callId, row.id] as const]
          : [],
      );

      expect(sharedRows.length).toBeGreaterThan(0);
      for (const [callId, id] of sharedRows) {
        expect(id).toBe(previousIdsByCall.get(callId));
        expect(id).not.toContain(":sequence-page:");
      }
    }
  });

  it("caps stored outputs before it expands a byte-budget slice", () => {
    const { db, thread } = setup();
    seedTurns(db, thread, {
      completeLastTurn: true,
      itemsPerTurn: [150],
      outputChars: 50_000,
    });

    const latest = buildNestedPage(db, thread, LARGE_BUDGET, null).response;
    const turnRow = latest.rows.find((row) => row.kind === "turn");
    expect(turnRow?.kind).toBe("turn");
    if (turnRow?.kind !== "turn") {
      throw new Error("expected a turn row");
    }
    const details = buildTimelineTurnSummaryDetails(db, thread, {
      includeProviderUnhandledOperations: false,
      sourceSeqEnd: turnRow.sourceSeqEnd,
      sourceSeqStart: turnRow.sourceSeqStart,
      turnId: turnRow.turnId,
    });
    const commandOutputs = details.rows.flatMap((row) =>
      row.kind === "work" && row.workKind === "command" ? [row.output] : [],
    );

    expect(commandOutputs.length).toBeGreaterThan(0);
    expect(commandOutputs.length).toBeLessThan(150);
    expect(commandOutputs.every((output) => output.length < 33_000)).toBe(true);
    expect(
      commandOutputs.some((output) =>
        output.includes("more characters truncated"),
      ),
    ).toBe(true);
  });

  it("expands each delegated byte-budget slice with realistic parent ordering", () => {
    const { db, thread } = setup();
    seedTurns(db, thread, {
      commandChars: 25_000,
      completeLastTurn: true,
      delegateLastTurn: true,
      itemsPerTurn: [BYTE_WINDOW_ITEM_COUNT],
    });

    const commandCallIds = new Set<string>();
    const expandedCommandCallIds = new Set<string>();
    let cursor: TimelinePaginationCursor | null = null;
    let pages = 0;
    for (;;) {
      const page = buildNestedPage(db, thread, LARGE_BUDGET, cursor);
      pages += 1;
      collectCommandCallIds(page.response.rows, commandCallIds);
      for (const row of page.response.rows) {
        if (row.kind !== "turn") {
          continue;
        }
        if (pages === 1) {
          expect(row.sourceSeqStart).toBeGreaterThan(4);
        }
        const details = buildTimelineTurnSummaryDetails(db, thread, {
          includeProviderUnhandledOperations: false,
          sourceSeqEnd: row.sourceSeqEnd,
          sourceSeqStart: row.sourceSeqStart,
          turnId: row.turnId,
        });
        const pageDetailCallIds = new Set<string>();
        collectCommandCallIds(details.rows, pageDetailCallIds);
        expect(pageDetailCallIds.size).toBeLessThan(BYTE_WINDOW_ITEM_COUNT);
        for (const callId of pageDetailCallIds) {
          expandedCommandCallIds.add(callId);
        }
      }
      expect(page.profile.eventDataBytes, `page ${pages}`).toBeLessThanOrEqual(
        THREAD_TIMELINE_EVENT_DATA_BYTE_LIMIT,
      );
      if (!page.response.timelinePage.hasOlderRows) {
        break;
      }
      cursor = page.response.timelinePage.olderCursor;
      expect(cursor).not.toBeNull();
      expect(pages).toBeLessThan(10);
    }

    expect(pages).toBeGreaterThan(2);
    expect(commandCallIds.size).toBe(BYTE_WINDOW_ITEM_COUNT);
    expect(expandedCommandCallIds.size).toBe(BYTE_WINDOW_ITEM_COUNT);
  }, 15_000);

  it("returns a placeholder when one event exceeds the byte limit", () => {
    const { db, thread } = setup();
    insertEvents(db, noopNotifier, [
      {
        threadId: thread.id,
        sequence: 1,
        type: "system/error",
        scope: threadScope(),
        itemId: null,
        itemKind: null,
        parentToolCallId: null,
        data: JSON.stringify({
          message: "x".repeat(THREAD_TIMELINE_EVENT_DATA_BYTE_LIMIT),
        }),
      },
    ]);

    const latest = buildPage(db, thread, LARGE_BUDGET, null);
    expect(latest.response.timelinePage.hasOlderRows).toBe(false);
    expect(latest.response.timelinePage.olderCursor).toBeNull();
    expect(latest.response.rows).toEqual([
      expect.objectContaining({
        kind: "system",
        sourceSeqStart: 1,
        status: "error",
        systemKind: "error",
        title: "Timeline event is too large to display",
      }),
    ]);
    expect(latest.profile.eventRowCount).toBe(0);
  });

  it("keeps a parented aggregate whole instead of bypassing the budget during closure", () => {
    const { db, thread } = setup();
    seedTurns(db, thread, {
      completeLastTurn: false,
      delegateLastTurn: true,
      itemsPerTurn: [300],
    });

    const unbudgeted = buildPage(db, thread, LARGE_BUDGET, null);
    const budgeted = buildPage(db, thread, 100, null);

    expect(budgeted.response.timelinePage.hasOlderRows).toBe(false);
    expect(budgeted.profile.eventRowCount).toBeGreaterThan(600);
    expect(budgeted.response.rows).toEqual(unbudgeted.response.rows);
  });

  it("gives an item straddling the cut to exactly one page, completed", () => {
    const { db, thread } = setup();
    seedTurns(db, thread, {
      completeLastTurn: false,
      itemsPerTurn: [300],
      longRunningItemIndexes: [0],
    });

    const straddlingRowId = `${thread.id}:command:turn-1-item-0`;
    const budgeted = walkAllPages(db, thread, 100);
    const matches = budgeted.rows.filter((row) =>
      row.includes(`"id":${JSON.stringify(straddlingRowId)}`),
    );

    expect(matches).toHaveLength(1);
    expect(matches[0]).toContain('"status":"completed"');
    expect(matches[0]).toContain("late output 0");
  });

  it("gives a straddling item to exactly one byte page's details, completed", () => {
    const { db, thread } = setup();
    seedTurns(db, thread, {
      commandChars: 25_000,
      completeLastTurn: true,
      itemsPerTurn: [BYTE_WINDOW_ITEM_COUNT],
      longRunningItemIndexes: [0],
    });

    const straddlingCallId = "turn-1-item-0";
    const straddlingDetailRows: TimelineRow[] = [];
    let cursor: TimelinePaginationCursor | null = null;
    let pages = 0;
    for (;;) {
      const page = buildNestedPage(db, thread, LARGE_BUDGET, cursor);
      pages += 1;
      for (const row of page.response.rows) {
        if (row.kind !== "turn") {
          continue;
        }
        const details = buildTimelineTurnSummaryDetails(db, thread, {
          includeProviderUnhandledOperations: false,
          sourceSeqEnd: row.sourceSeqEnd,
          sourceSeqStart: row.sourceSeqStart,
          turnId: row.turnId,
        });
        for (const detailRow of details.rows) {
          if (
            detailRow.kind === "work" &&
            detailRow.workKind === "command" &&
            detailRow.callId === straddlingCallId
          ) {
            straddlingDetailRows.push(detailRow);
          }
        }
      }
      if (!page.response.timelinePage.hasOlderRows) {
        break;
      }
      cursor = page.response.timelinePage.olderCursor;
      expect(cursor).not.toBeNull();
      expect(pages).toBeLessThan(10);
    }

    expect(pages).toBeGreaterThan(2);
    expect(straddlingDetailRows).toHaveLength(1);
    expect(straddlingDetailRows[0]).toEqual(
      expect.objectContaining({
        output: expect.stringContaining("late output 0"),
        status: "completed",
      }),
    );
  }, 15_000);

  it("rejects a sequence cursor whose id and sequence disagree", () => {
    const { db, thread } = setup();
    seedTurns(db, thread, { completeLastTurn: false, itemsPerTurn: [300] });

    const cursor = buildPage(db, thread, 100, null).response.timelinePage
      .olderCursor;
    expect(cursor).not.toBeNull();

    expect(() =>
      buildPage(db, thread, 100, {
        anchorId: cursor!.anchorId,
        anchorSeq: cursor!.anchorSeq + 1,
      }),
    ).toThrow(/no longer available/);
  });

  it("does not read past its cursor on an older page", () => {
    const { db, thread } = setup();
    seedTurns(db, thread, {
      completeLastTurn: true,
      itemsPerTurn: [5, 5, 400],
    });

    const latest = buildPage(db, thread, 100, null);
    expect(latest.profile.eventRowCount).toBeGreaterThan(700);
    const cursor = latest.response.timelinePage.olderCursor;
    expect(cursor).not.toBeNull();

    const older = buildPage(db, thread, 100, cursor);
    expect(older.profile.eventRowCount).toBeLessThan(100);
    expect(
      older.response.rows.some((row) => row.sourceSeqStart > cursor!.anchorSeq),
    ).toBe(false);
  });
});

describe("timeline segment anchors", () => {
  it("includes provisioning before the first visible user message", () => {
    const { db, thread } = setup();
    const fillerEvent = (sequence: number): EventInput => ({
      threadId: thread.id,
      sequence,
      type: "system/operation",
      scope: threadScope(),
      itemId: null,
      itemKind: null,
      parentToolCallId: null,
      data: JSON.stringify({
        operation: "event_budget_filler",
        status: "completed",
        message: `Visible operation ${sequence}`,
        operationId: `event-budget-${sequence}`,
      }),
    });
    insertEvents(db, noopNotifier, [
      {
        threadId: thread.id,
        sequence: 1,
        type: "client/turn/requested",
        scope: threadScope(),
        itemId: null,
        itemKind: null,
        parentToolCallId: null,
        data: JSON.stringify({
          direction: "outbound",
          source: "spawn",
          initiator: "user",
          request: { method: "turn/start", params: {} },
          requestId: requestId(1),
          senderThreadId: null,
          input: [{ type: "text", text: "", mentions: [] }],
          target: { kind: "thread-start" },
          execution,
        }),
      },
      {
        threadId: thread.id,
        sequence: 2,
        type: "system/thread-provisioning",
        scope: threadScope(),
        itemId: null,
        itemKind: null,
        parentToolCallId: null,
        data: JSON.stringify({
          provisioningId: "tpv-first-message",
          status: "completed",
          environmentId: "env-first-message",
          entries: [],
        }),
      },
      {
        threadId: thread.id,
        sequence: 3,
        type: "client/turn/requested",
        scope: threadScope(),
        itemId: null,
        itemKind: null,
        parentToolCallId: null,
        data: JSON.stringify({
          direction: "outbound",
          source: "tell",
          initiator: "user",
          request: { method: "turn/start", params: {} },
          requestId: requestId(2),
          senderThreadId: null,
          input: [{ type: "text", text: "Start now", mentions: [] }],
          target: { kind: "new-turn" },
          execution,
        }),
      },
    ]);

    insertEvents(
      db,
      noopNotifier,
      Array.from({ length: 1_498 }, (_, index) => fillerEvent(index + 4)),
    );

    const timeline = buildPage(db, thread, 1_501, null).response;

    expect(timeline.timelinePage.hasOlderRows).toBe(false);
    expect(timeline.timelinePage.olderCursor).toBeNull();
    expect(timeline.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "system",
          systemKind: "operation",
          title: "Provisioned thread",
        }),
        expect.objectContaining({
          kind: "conversation",
          role: "user",
          text: "Start now",
        }),
      ]),
    );

    const budgeted = buildPage(db, thread, 1_500, null).response;
    expect(budgeted.timelinePage.olderCursor).toEqual({
      anchorSeq: 3,
      anchorId: `${thread.id}:user-seed:3`,
    });
    expect(
      budgeted.rows.some(
        (row) =>
          row.kind === "system" &&
          row.systemKind === "operation" &&
          row.title === "Provisioned thread",
      ),
    ).toBe(false);

    insertEvents(db, noopNotifier, [fillerEvent(1_502), fillerEvent(1_503)]);
    const exactFloor = buildPage(db, thread, 1_500, null).response.timelinePage;
    expect(exactFloor.olderCursor).toEqual({
      anchorSeq: 3,
      anchorId: `${thread.id}:user-seed:3`,
    });

    const latest = buildPage(db, thread, LARGE_BUDGET, null, 1).response;
    expect(latest.timelinePage.hasOlderRows).toBe(true);
    expect(latest.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "conversation",
          role: "user",
          text: "Start now",
        }),
      ]),
    );
    if (latest.timelinePage.olderCursor === null) {
      throw new Error("expected an older timeline cursor");
    }

    const older = buildPage(
      db,
      thread,
      LARGE_BUDGET,
      latest.timelinePage.olderCursor,
      1,
    ).response;
    expect(older.timelinePage.hasOlderRows).toBe(false);
    expect(older.timelinePage.olderCursor).toBeNull();
    expect(older.rows).toEqual([
      expect.objectContaining({
        kind: "system",
        systemKind: "operation",
        title: "Provisioned thread",
      }),
    ]);
  });

  it("treats a steer sent with nothing running as a pageable anchor", () => {
    const { db, thread } = setup();
    seedTurns(db, thread, { completeLastTurn: true, itemsPerTurn: [40] });
    insertEvents(db, noopNotifier, [
      {
        threadId: thread.id,
        sequence: 1_000,
        type: "client/turn/requested",
        scope: threadScope(),
        itemId: null,
        itemKind: null,
        parentToolCallId: null,
        data: JSON.stringify({
          direction: "outbound",
          source: "tell",
          initiator: "user",
          request: { method: "turn/start", params: {} },
          requestId: requestId(99),
          senderThreadId: null,
          input: [{ type: "text", text: "Steered follow-up", mentions: [] }],
          target: { kind: "steer", expectedTurnId: null },
          execution,
        }),
      },
      {
        threadId: thread.id,
        sequence: 1_001,
        type: "turn/started",
        scope: turnScope("turn-steer"),
        providerThreadId,
        itemId: null,
        itemKind: null,
        parentToolCallId: null,
        data: JSON.stringify({}),
      },
    ]);

    const walked = walkAllPages(db, thread, 20);
    expect(walked.pages).toBeGreaterThan(1);
    expect(walked.rows).toEqual(walkAllPages(db, thread, LARGE_BUDGET).rows);
  });
});

describe("timeline window event exclusions", () => {
  it("never reads workspace diff events into a window", () => {
    const { db, thread } = setup();
    seedTurns(db, thread, { completeLastTurn: true, itemsPerTurn: [5] });
    const withoutDiffs = buildPage(db, thread, LARGE_BUDGET, null);

    insertEvents(db, noopNotifier, [
      {
        threadId: thread.id,
        sequence: 500,
        type: "turn/diff/updated",
        scope: turnScope("turn-1"),
        providerThreadId,
        itemId: null,
        itemKind: null,
        parentToolCallId: null,
        data: JSON.stringify({ diff: "x".repeat(50_000) }),
      },
    ]);

    const withDiffs = buildPage(db, thread, LARGE_BUDGET, null);
    expect(withDiffs.profile.eventRowCount).toBe(
      withoutDiffs.profile.eventRowCount,
    );
    expect(withDiffs.response.rows).toEqual(withoutDiffs.response.rows);
  });
});

describe("timeline inline output reads", () => {
  it("shortens an oversized command output during the read", () => {
    const { db, thread } = setup();
    seedTurns(db, thread, { completeLastTurn: false, itemsPerTurn: [1] });
    const output = "x".repeat(50_000);
    insertEvents(db, noopNotifier, [
      {
        threadId: thread.id,
        sequence: 500,
        type: "item/completed",
        scope: turnScope("turn-1"),
        providerThreadId,
        itemId: "big-item",
        itemKind: "commandExecution",
        parentToolCallId: null,
        data: JSON.stringify({
          item: {
            type: "commandExecution",
            id: "big-item",
            command: "cat big",
            cwd: "/tmp/test",
            status: "completed",
            approvalStatus: null,
            exitCode: 0,
            aggregatedOutput: output,
          },
        }),
      },
    ]);

    const capped = buildThreadTimeline(db, thread, {
      eventBudget: LARGE_BUDGET,
      includeProviderUnhandledOperations: false,
      includeNestedRows: false,
      maxInlineOutputChars: 32_000,
      maxSeq: 0,
      page: { kind: "latest", segmentLimit: 20 },
    });
    const uncapped = buildThreadTimeline(db, thread, {
      eventBudget: LARGE_BUDGET,
      includeProviderUnhandledOperations: false,
      includeNestedRows: false,
      maxInlineOutputChars: null,
      maxSeq: 0,
      page: { kind: "latest", segmentLimit: 20 },
    });

    const cappedRow = capped.rows.find(
      (row) => row.kind === "work" && row.id.endsWith("big-item"),
    );
    const uncappedRow = uncapped.rows.find(
      (row) => row.kind === "work" && row.id.endsWith("big-item"),
    );
    expect(cappedRow?.kind).toBe("work");
    expect(uncappedRow?.kind).toBe("work");
    if (cappedRow?.kind !== "work" || uncappedRow?.kind !== "work") {
      throw new Error("expected work rows");
    }
    if (
      cappedRow.workKind !== "command" ||
      uncappedRow.workKind !== "command"
    ) {
      throw new Error("expected command rows");
    }
    expect(uncappedRow.output).toBe(output);
    expect(cappedRow.output).toBe(
      `${"x".repeat(32_000)}\n…[18,000 more characters truncated]`,
    );
  });
});

describe("background tasks across an in-turn window", () => {
  it("keeps the running-workflow banner when the window starts after the task began", () => {
    const { db, thread } = setup();
    seedTurns(db, thread, {
      backgroundTask: "open",
      completeLastTurn: false,
      itemsPerTurn: [300],
    });

    const budgeted = buildPage(db, thread, 100, null);
    expect(budgeted.response.timelinePage.olderCursor?.anchorId).toMatch(
      /:in-turn:/,
    );
    expect(budgeted.profile.eventRowCount).toBeLessThanOrEqual(120);
    expect(budgeted.response.activeWorkflows).toHaveLength(1);
    expect(budgeted.response.activeWorkflows).toEqual(
      buildPage(db, thread, LARGE_BUDGET, null).response.activeWorkflows,
    );
  });

  it("drops the banner once the task completes, whatever the window", () => {
    const { db, thread } = setup();
    seedTurns(db, thread, {
      backgroundTask: "completed",
      completeLastTurn: false,
      itemsPerTurn: [300],
    });

    expect(buildPage(db, thread, 100, null).response.activeWorkflows).toEqual(
      [],
    );
  });
});

describe("in-turn windows and items that only stream", () => {
  it("gives an item to one page when its in-window presence is output deltas", () => {
    const { db, thread } = setup();
    seedTurns(db, thread, {
      completeLastTurn: false,
      itemsPerTurn: [300],
      longRunningItemIndexes: [0],
      streamLongRunningOutput: true,
    });

    const streamingRowId = `${thread.id}:command:turn-1-item-0`;
    const budgeted = walkAllPages(db, thread, 100);
    const matches = budgeted.rows.filter((row) =>
      row.includes(`"id":${JSON.stringify(streamingRowId)}`),
    );

    expect(budgeted.pages).toBeGreaterThan(1);
    expect(matches).toHaveLength(1);
    expect(matches[0]).toContain('"status":"completed"');
  });

  it.each([
    { includeStartedEvent: false, providerShape: "without item/started" },
    { includeStartedEvent: true, providerShape: "with item/started" },
  ])(
    "keeps an unfinished assistant message whole across the cut $providerShape",
    ({ includeStartedEvent }) => {
      const { db, thread } = setup();
      const itemId = "assistant-1";
      const turnId = "turn-1";
      seedTurns(db, thread, {
        completeLastTurn: false,
        itemsPerTurn: [100],
      });
      const events: EventInput[] = includeStartedEvent
        ? [
            {
              threadId: thread.id,
              sequence: 204,
              type: "item/started",
              scope: turnScope(turnId),
              providerThreadId,
              itemId,
              itemKind: "agentMessage",
              parentToolCallId: null,
              data: JSON.stringify({
                item: { type: "agentMessage", id: itemId, text: "" },
                providerThreadId,
              }),
            },
          ]
        : [];
      const firstDeltaSequence = includeStartedEvent ? 205 : 204;
      const chunks = Array.from({ length: 200 }, (_, index) => `[${index}]\n`);
      chunks.forEach((delta, index) => {
        events.push({
          threadId: thread.id,
          sequence: index + firstDeltaSequence,
          type: "item/agentMessage/delta",
          scope: turnScope(turnId),
          providerThreadId,
          itemId,
          itemKind: null,
          parentToolCallId: null,
          data: JSON.stringify({
            delta,
            itemId,
            providerThreadId,
          }),
        });
      });
      insertEvents(db, noopNotifier, events);

      const budgeted = buildPage(db, thread, 100, null);
      const assistant = budgeted.response.rows.find(
        (row) => row.kind === "conversation" && row.role === "assistant",
      );

      expect(budgeted.response.timelinePage.hasOlderRows).toBe(true);
      expect(assistant?.text).toBe(chunks.join(""));
      const laterChunks = Array.from(
        { length: 25 },
        (_, index) => `[later-${index}]\n`,
      );
      insertEvents(
        db,
        noopNotifier,
        laterChunks.map((delta, index) => ({
          threadId: thread.id,
          sequence: index + firstDeltaSequence + chunks.length,
          type: "item/agentMessage/delta",
          scope: turnScope(turnId),
          providerThreadId,
          itemId,
          itemKind: null,
          parentToolCallId: null,
          data: JSON.stringify({
            delta,
            itemId,
            providerThreadId,
          }),
        })),
      );

      const refreshed = buildPage(db, thread, 100, null);
      const refreshedAssistant = refreshed.response.rows.find(
        (row) => row.kind === "conversation" && row.role === "assistant",
      );
      expect(refreshedAssistant?.text).toBe(
        [...chunks, ...laterChunks].join(""),
      );
      const unbudgeted = buildPage(db, thread, LARGE_BUDGET, null);
      expect(walkAllPages(db, thread, 100).rows).toEqual(
        unbudgeted.response.rows.map((row) => JSON.stringify(row)),
      );
    },
  );
});

function seedCrossTurnCompletion(
  db: DbConnection,
  thread: Thread,
  options: { reuseCallIdInLaterTurn: boolean },
): void {
  const events: EventInput[] = [];
  let sequence = 0;
  const push = (event: Omit<EventInput, "sequence" | "threadId">): void => {
    sequence += 1;
    events.push({ ...event, sequence, threadId: thread.id });
  };
  const command = (
    turnId: string,
    status: "pending" | "completed",
    output: string | null,
  ): Omit<EventInput, "sequence" | "threadId"> => ({
    type: status === "pending" ? "item/started" : "item/completed",
    scope: turnScope(turnId),
    providerThreadId,
    itemId: "call-1",
    itemKind: "commandExecution",
    parentToolCallId: null,
    data: JSON.stringify({
      item: {
        type: "commandExecution",
        id: "call-1",
        command: "npm run dev",
        cwd: "/tmp/test",
        status,
        approvalStatus: null,
        ...(output === null ? {} : { exitCode: 0, aggregatedOutput: output }),
      },
    }),
  });
  const agentMessage = (
    turnId: string,
    id: string,
    text: string,
  ): Omit<EventInput, "sequence" | "threadId"> => ({
    type: "item/completed",
    scope: turnScope(turnId),
    providerThreadId,
    itemId: id,
    itemKind: "agentMessage",
    parentToolCallId: null,
    data: JSON.stringify({ item: { type: "agentMessage", id, text } }),
  });
  const turnLifecycle = (
    turnId: string,
    type: "turn/started" | "turn/completed",
  ): Omit<EventInput, "sequence" | "threadId"> => ({
    type,
    scope: turnScope(turnId),
    providerThreadId,
    itemId: null,
    itemKind: null,
    parentToolCallId: null,
    data: JSON.stringify(
      type === "turn/started" ? {} : { status: "completed", providerThreadId },
    ),
  });

  push(turnLifecycle("turn-1", "turn/started"));
  push(command("turn-1", "pending", null));
  if (options.reuseCallIdInLaterTurn) {
    push(command("turn-1", "completed", "first run"));
  }
  push(agentMessage("turn-1", "msg-1", "Dev server is starting."));
  push(turnLifecycle("turn-1", "turn/completed"));
  push(turnLifecycle("turn-2", "turn/started"));
  if (options.reuseCallIdInLaterTurn) {
    push(command("turn-2", "pending", null));
    push(command("turn-2", "completed", "second run"));
  } else {
    push({
      type: "item/completed",
      scope: turnScope("turn-2"),
      providerThreadId,
      itemId: "call-1",
      itemKind: "toolCall",
      parentToolCallId: null,
      data: JSON.stringify({
        item: {
          type: "toolCall",
          id: "call-1",
          tool: "unknown",
          status: "completed",
          result: "dev server exited with code 0",
        },
      }),
    });
  }
  push(agentMessage("turn-2", "msg-2", "Second turn done."));
  push(turnLifecycle("turn-2", "turn/completed"));

  insertEvents(db, noopNotifier, events);
}

function collectTurnDetailsAndChildren(
  db: DbConnection,
  thread: Thread,
): Map<string, { children: TimelineRow[]; details: TimelineRow[] }> {
  const byTurnId = new Map<
    string,
    { children: TimelineRow[]; details: TimelineRow[] }
  >();
  for (const row of buildNestedPage(db, thread, LARGE_BUDGET, null).response
    .rows) {
    if (row.kind !== "turn") {
      continue;
    }
    byTurnId.set(row.turnId, {
      children: row.children ?? [],
      details: buildTimelineTurnSummaryDetails(db, thread, {
        includeProviderUnhandledOperations: false,
        sourceSeqEnd: row.sourceSeqEnd,
        sourceSeqStart: row.sourceSeqStart,
        turnId: row.turnId,
      }).rows,
    });
  }
  return byTurnId;
}

describe("turn details for an item that finishes in a later turn", () => {
  it("retains interrupted thinking when the provider completes the item after Stop", () => {
    const { db, thread } = setup();
    seedTurns(db, thread, { completeLastTurn: false, itemsPerTurn: [0] });
    const firstSequence = getLatestThreadSequence(db, { threadId: thread.id });
    const turnId = "turn-1";
    const itemId = "stopped-reasoning";
    const text = "Checking each constraint before choosing a solution.";
    const events: EventInput[] = [];
    const push = (event: Omit<EventInput, "sequence" | "threadId">) => {
      events.push({
        ...event,
        sequence: firstSequence + events.length + 1,
        threadId: thread.id,
      });
    };
    const base = {
      scope: turnScope(turnId),
      providerThreadId,
      parentToolCallId: null,
      itemId: null,
      itemKind: null,
    };
    push({
      ...base,
      type: "item/started",
      itemId,
      itemKind: "reasoning",
      data: JSON.stringify({
        item: { type: "reasoning", id: itemId, summary: [], content: [] },
      }),
    });
    push({
      ...base,
      type: "item/reasoning/textDelta",
      itemId,
      data: JSON.stringify({ itemId, delta: "Checking" }),
    });
    push({
      ...base,
      type: "system/thread/interrupted",
      scope: threadScope(),
      data: JSON.stringify({ reason: "manual-stop" }),
    });
    insertEvents(db, noopNotifier, events);
    const before = buildNestedPage(db, thread, LARGE_BUDGET, null).response;
    const beforeThought = before.rows.find(
      (row) => row.kind === "system" && row.title.startsWith("Thought for"),
    );
    expect(beforeThought).toMatchObject({
      detail: "Checking",
      status: "interrupted",
    });

    const storedCount = events.length;
    push({
      ...base,
      type: "item/completed",
      itemId,
      itemKind: "reasoning",
      data: JSON.stringify({
        item: { type: "reasoning", id: itemId, summary: [], content: [text] },
      }),
    });
    push({
      ...base,
      type: "turn/completed",
      data: JSON.stringify({ status: "interrupted", providerThreadId }),
    });
    insertEvents(db, noopNotifier, events.slice(storedCount));

    const after = collectTurnDetailsAndChildren(db, thread).get(turnId);
    const thoughts = after?.details.filter(
      (row) => row.kind === "system" && row.title.startsWith("Thought for"),
    );
    expect(thoughts).toEqual([
      expect.objectContaining({
        id: beforeThought?.id,
        detail: text,
        status: "interrupted",
        sourceSeqStart: firstSequence + 1,
        sourceSeqEnd: firstSequence + 4,
      }),
    ]);
    expect(after?.details).toEqual(after?.children);
    expect(collectTurnDetailsAndChildren(db, thread).get(turnId)).toEqual(
      after,
    );
  });

  it("shows the spawning turn's item completed with its late output", () => {
    const { db, thread } = setup();
    seedCrossTurnCompletion(db, thread, { reuseCallIdInLaterTurn: false });

    const turns = collectTurnDetailsAndChildren(db, thread);
    const turn1 = turns.get("turn-1");
    expect(turn1).toBeDefined();
    expect(turn1!.children).toEqual([
      expect.objectContaining({
        callId: "call-1",
        output: "dev server exited with code 0",
        sourceSeqEnd: 6,
        status: "completed",
      }),
    ]);
    expect(turn1!.details).toEqual(turn1!.children);
  });

  it("keeps a later turn's reuse of the call id out of the spawning turn", () => {
    const { db, thread } = setup();
    seedCrossTurnCompletion(db, thread, { reuseCallIdInLaterTurn: true });

    const turns = collectTurnDetailsAndChildren(db, thread);
    expect([...turns.keys()]).toEqual(["turn-1", "turn-2"]);
    for (const [turnId, { children, details }] of turns) {
      expect(children, turnId).toEqual([
        expect.objectContaining({
          callId: "call-1",
          output: turnId === "turn-1" ? "first run" : "second run",
          status: "completed",
        }),
      ]);
      expect(details, turnId).toEqual(children);
    }
  });
});
