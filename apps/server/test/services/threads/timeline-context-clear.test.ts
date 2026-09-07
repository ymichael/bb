import { describe, expect, it } from "vitest";
import {
  encodeClientTurnRequestIdNumber,
  THREAD_CONTEXT_CLEAR_OPERATION,
  threadScope,
  turnScope,
  type Thread,
} from "@bb/domain";
import {
  createConnection,
  createProject,
  createThread,
  insertEvents,
  listEvents,
  migrate,
  noopNotifier,
  upsertHost,
  type DbConnection,
} from "@bb/db";
import {
  buildThreadConversationOutline,
  buildThreadTimeline,
  THREAD_TIMELINE_EVENT_DATA_BYTE_LIMIT,
} from "../../../src/services/threads/timeline.js";

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
    providerId: "codex",
  });
  return { db, thread };
}

describe("timeline context-clear epochs", () => {
  it("excludes large old events from byte budgets and rejects cursors before the boundary", () => {
    const { db, thread } = setup();
    try {
      insertEvents(db, noopNotifier, [
        {
          threadId: thread.id,
          sequence: 1,
          type: "system/manager/user_message",
          scope: threadScope(),
          itemId: null,
          itemKind: null,
          parentToolCallId: null,
          data: JSON.stringify({
            text: "x".repeat(THREAD_TIMELINE_EVENT_DATA_BYTE_LIMIT + 1),
          }),
        },
        {
          threadId: thread.id,
          sequence: 2,
          type: "system/operation",
          scope: threadScope(),
          itemId: null,
          itemKind: null,
          parentToolCallId: null,
          data: JSON.stringify({
            operation: THREAD_CONTEXT_CLEAR_OPERATION,
            operationId: "clear",
            status: "completed",
            message: "Fresh context",
          }),
        },
      ]);
      const options = {
        eventBudget: 1_000,
        includeNestedRows: true,
        includeProviderUnhandledOperations: false,
        maxInlineOutputChars: null,
        maxSeq: 2,
      };
      const latest = buildThreadTimeline(db, thread, {
        ...options,
        page: { kind: "latest", segmentLimit: 20 },
      });
      expect(latest.rows).toEqual([
        expect.objectContaining({
          sourceSeqStart: 2,
          title: "Context cleared",
        }),
      ]);
      expect(latest.timelinePage).toMatchObject({
        hasOlderRows: false,
        olderCursor: null,
      });
      const boundary = latest.rows[0]!;
      const older = buildThreadTimeline(db, thread, {
        ...options,
        page: {
          kind: "older",
          segmentLimit: 20,
          beforeCursor: {
            anchorId: boundary.id,
            anchorSeq: boundary.sourceSeqStart,
          },
        },
      });
      expect(older.rows).toEqual([]);
      expect(older.timelinePage).toMatchObject({
        hasOlderRows: false,
        olderCursor: null,
      });
      expect(() =>
        buildThreadTimeline(db, thread, {
          ...options,
          page: {
            kind: "older",
            segmentLimit: 20,
            beforeCursor: { anchorId: "old-anchor", anchorSeq: 1 },
          },
        }),
      ).toThrow("Timeline pagination cursor is before the context boundary");
    } finally {
      db.$client.close();
    }
  });

  it("shows only the latest completed epoch while retaining older events", () => {
    const { db, thread } = setup();
    insertEvents(db, noopNotifier, [
      {
        threadId: thread.id,
        sequence: 1,
        type: "system/manager/user_message",
        scope: threadScope(),
        itemId: null,
        itemKind: null,
        parentToolCallId: null,
        data: JSON.stringify({ text: "Old visible response" }),
      },
      {
        threadId: thread.id,
        sequence: 2,
        type: "thread/contextWindowUsage/updated",
        scope: turnScope("old-turn"),
        providerThreadId: "provider-old",
        itemId: null,
        itemKind: null,
        parentToolCallId: null,
        data: JSON.stringify({
          contextWindowUsage: {
            estimated: false,
            modelContextWindow: 100_000,
            usedTokens: 9_000,
          },
        }),
      },
      {
        threadId: thread.id,
        sequence: 3,
        type: "system/operation",
        scope: threadScope(),
        itemId: null,
        itemKind: null,
        parentToolCallId: null,
        data: JSON.stringify({
          operation: THREAD_CONTEXT_CLEAR_OPERATION,
          operationId: "failed-clear",
          status: "failed",
          message: "Clear failed",
        }),
      },
      {
        threadId: thread.id,
        sequence: 4,
        type: "system/manager/user_message",
        scope: threadScope(),
        itemId: null,
        itemKind: null,
        parentToolCallId: null,
        data: JSON.stringify({ text: "Still visible before success" }),
      },
      {
        threadId: thread.id,
        sequence: 5,
        type: "system/operation",
        scope: threadScope(),
        itemId: null,
        itemKind: null,
        parentToolCallId: null,
        data: JSON.stringify({
          operation: THREAD_CONTEXT_CLEAR_OPERATION,
          operationId: "completed-clear",
          status: "completed",
          message: "Fresh context",
        }),
      },
      {
        threadId: thread.id,
        sequence: 6,
        type: "system/manager/user_message",
        scope: threadScope(),
        itemId: null,
        itemKind: null,
        parentToolCallId: null,
        data: JSON.stringify({ text: "Newest response" }),
      },
    ]);

    const timeline = buildThreadTimeline(db, thread, {
      eventBudget: 1_000,
      includeNestedRows: true,
      includeProviderUnhandledOperations: false,
      maxInlineOutputChars: null,
      maxSeq: 6,
      page: { kind: "latest", segmentLimit: 20 },
    });

    expect(timeline.contextBoundarySeq).toBe(5);
    expect(
      timeline.rows.map((row) => {
        if (row.kind === "conversation") return row.text;
        if (row.kind === "system") return row.title;
        return row.kind;
      }),
    ).toEqual(["Context cleared", "Newest response"]);
    expect(timeline.contextWindowUsage).toBeUndefined();
    expect(timeline.timelinePage).toMatchObject({
      hasOlderRows: false,
      olderCursor: null,
    });
    expect(
      buildThreadConversationOutline(db, thread, { maxSeq: 6 }).items.map(
        (item) => item.preview,
      ),
    ).toEqual(["Newest response"]);
    expect(listEvents(db, { threadId: thread.id })).toHaveLength(6);
    db.$client.close();
  });

  it("never paginates older rows across the completed context boundary", () => {
    const { db, thread } = setup();
    const requestEvent = (sequence: number, value: number, text: string) => ({
      threadId: thread.id,
      sequence,
      type: "client/turn/requested" as const,
      scope: threadScope(),
      itemId: null,
      itemKind: null,
      parentToolCallId: null,
      data: JSON.stringify({
        direction: "outbound",
        source: "tell",
        initiator: "user",
        request: { method: "turn/start", params: {} },
        requestId: encodeClientTurnRequestIdNumber({ value }),
        senderThreadId: null,
        input: [{ type: "text", text, mentions: [] }],
        target: { kind: "new-turn" },
        execution: {
          model: "gpt-5",
          serviceTier: "default",
          reasoningLevel: "medium",
          permissionMode: "full",
          source: "client/turn/requested",
        },
      }),
    });
    insertEvents(db, noopNotifier, [
      {
        threadId: thread.id,
        sequence: 1,
        type: "system/manager/user_message",
        scope: threadScope(),
        itemId: null,
        itemKind: null,
        parentToolCallId: null,
        data: JSON.stringify({ text: "Old chat must stay hidden" }),
      },
      {
        threadId: thread.id,
        sequence: 2,
        type: "system/operation",
        scope: threadScope(),
        itemId: null,
        itemKind: null,
        parentToolCallId: null,
        data: JSON.stringify({
          operation: THREAD_CONTEXT_CLEAR_OPERATION,
          operationId: "completed-clear",
          status: "completed",
          message: "Fresh context",
        }),
      },
      requestEvent(3, 1, "First fresh message"),
      {
        threadId: thread.id,
        sequence: 4,
        type: "system/manager/user_message",
        scope: threadScope(),
        itemId: null,
        itemKind: null,
        parentToolCallId: null,
        data: JSON.stringify({ text: "First fresh response" }),
      },
      requestEvent(5, 2, "Second fresh message"),
      {
        threadId: thread.id,
        sequence: 6,
        type: "system/manager/user_message",
        scope: threadScope(),
        itemId: null,
        itemKind: null,
        parentToolCallId: null,
        data: JSON.stringify({ text: "Second fresh response" }),
      },
    ]);

    let page = buildThreadTimeline(db, thread, {
      eventBudget: 1_000,
      includeNestedRows: true,
      includeProviderUnhandledOperations: false,
      maxInlineOutputChars: null,
      maxSeq: 6,
      page: { kind: "latest", segmentLimit: 1 },
    });
    const rowSequences: number[] = [];

    for (;;) {
      expect(page.contextBoundarySeq).toBe(2);
      rowSequences.push(...page.rows.map((row) => row.sourceSeqStart));
      expect(page.rows.every((row) => row.sourceSeqStart >= 2)).toBe(true);
      if (!page.timelinePage.hasOlderRows) break;
      const cursor = page.timelinePage.olderCursor;
      if (cursor === null) throw new Error("expected an older cursor");
      expect(cursor.anchorSeq).toBeGreaterThanOrEqual(2);
      page = buildThreadTimeline(db, thread, {
        eventBudget: 1_000,
        includeNestedRows: true,
        includeProviderUnhandledOperations: false,
        maxInlineOutputChars: null,
        maxSeq: 6,
        page: { kind: "older", segmentLimit: 1, beforeCursor: cursor },
      });
    }

    expect(rowSequences).toContain(2);
    expect(rowSequences).not.toContain(1);
    expect(page.timelinePage).toMatchObject({
      hasOlderRows: false,
      olderCursor: null,
    });
    db.$client.close();
  });
});
