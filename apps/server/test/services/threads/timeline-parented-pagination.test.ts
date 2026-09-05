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
  insertEvents,
  migrate,
  noopNotifier,
  upsertHost,
} from "@bb/db";
import type { DbConnection } from "@bb/db";
import type { TimelineRow } from "@bb/server-contract";
import { buildThreadTimeline } from "../../../src/services/threads/timeline.js";

const providerThreadId = "provider-root";

const execution = {
  model: "gpt-5",
  serviceTier: "default",
  reasoningLevel: "medium",
  permissionMode: "full",
  source: "client/turn/requested",
} as const;

interface SetupResult {
  db: DbConnection;
  thread: Thread;
}

function setup(): SetupResult {
  const db = createConnection(":memory:");
  migrate(db);
  const host = upsertHost(db, noopNotifier, {
    name: "test-host",
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

function requestId(value: number): ClientTurnRequestId {
  return encodeClientTurnRequestIdNumber({ value });
}

function insertCrossWindowSubagentEvents(
  db: DbConnection,
  thread: Thread,
): void {
  const firstRequestId = requestId(1);
  const secondRequestId = requestId(2);
  const thirdRequestId = requestId(3);
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
        request: { method: "thread/start", params: {} },
        requestId: firstRequestId,
        senderThreadId: null,
        input: [{ type: "text", text: "Start parent turn.", mentions: [] }],
        target: { kind: "thread-start" },
        execution,
      }),
    },
    {
      threadId: thread.id,
      sequence: 2,
      type: "turn/started",
      scope: turnScope("parent-turn"),
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
      scope: turnScope("parent-turn"),
      providerThreadId,
      itemId: null,
      itemKind: null,
      parentToolCallId: null,
      data: JSON.stringify({ clientRequestId: firstRequestId }),
    },
    {
      threadId: thread.id,
      sequence: 4,
      type: "item/started",
      scope: turnScope("parent-turn"),
      providerThreadId,
      itemId: "toolu_agent_1",
      itemKind: "toolCall",
      parentToolCallId: null,
      data: JSON.stringify({
        item: {
          type: "toolCall",
          id: "toolu_agent_1",
          tool: "Agent",
          arguments: {
            prompt: "Run the child.",
            subagent_type: "general-purpose",
          },
          status: "pending",
        },
      }),
    },
    {
      threadId: thread.id,
      sequence: 5,
      type: "item/completed",
      scope: turnScope("parent-turn"),
      providerThreadId,
      itemId: "toolu_agent_1",
      itemKind: "toolCall",
      parentToolCallId: null,
      data: JSON.stringify({
        item: {
          type: "toolCall",
          id: "toolu_agent_1",
          tool: "Agent",
          arguments: {
            prompt: "Run the child.",
            subagent_type: "general-purpose",
          },
          result: "FIRST_SUBAGENT_OUTPUT",
          status: "completed",
        },
      }),
    },
    {
      threadId: thread.id,
      sequence: 20,
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
        requestId: secondRequestId,
        senderThreadId: null,
        input: [{ type: "text", text: "Middle turn.", mentions: [] }],
        target: { kind: "new-turn" },
        execution,
      }),
    },
    {
      threadId: thread.id,
      sequence: 21,
      type: "turn/started",
      scope: turnScope("middle-turn"),
      providerThreadId,
      itemId: null,
      itemKind: null,
      parentToolCallId: null,
      data: JSON.stringify({}),
    },
    {
      threadId: thread.id,
      sequence: 22,
      type: "turn/input/accepted",
      scope: turnScope("middle-turn"),
      providerThreadId,
      itemId: null,
      itemKind: null,
      parentToolCallId: null,
      data: JSON.stringify({ clientRequestId: secondRequestId }),
    },
    {
      threadId: thread.id,
      sequence: 23,
      type: "item/completed",
      scope: turnScope("middle-turn"),
      providerThreadId,
      itemId: "middle-message",
      itemKind: "agentMessage",
      parentToolCallId: null,
      data: JSON.stringify({
        item: {
          type: "agentMessage",
          id: "middle-message",
          text: "Middle response.",
        },
      }),
    },
    {
      threadId: thread.id,
      sequence: 40,
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
        requestId: thirdRequestId,
        senderThreadId: null,
        input: [{ type: "text", text: "Newest turn.", mentions: [] }],
        target: { kind: "new-turn" },
        execution,
      }),
    },
    {
      threadId: thread.id,
      sequence: 41,
      type: "turn/started",
      scope: turnScope("newest-turn"),
      providerThreadId,
      itemId: null,
      itemKind: null,
      parentToolCallId: null,
      data: JSON.stringify({}),
    },
    {
      threadId: thread.id,
      sequence: 42,
      type: "turn/input/accepted",
      scope: turnScope("newest-turn"),
      providerThreadId,
      itemId: null,
      itemKind: null,
      parentToolCallId: null,
      data: JSON.stringify({ clientRequestId: thirdRequestId }),
    },
    {
      threadId: thread.id,
      sequence: 43,
      type: "item/completed",
      scope: turnScope("newest-turn"),
      providerThreadId,
      itemId: "newest-message",
      itemKind: "agentMessage",
      parentToolCallId: null,
      data: JSON.stringify({
        item: {
          type: "agentMessage",
          id: "newest-message",
          text: "Newest response.",
        },
      }),
    },
    {
      threadId: thread.id,
      sequence: 50,
      type: "turn/started",
      scope: turnScope("child-turn"),
      providerThreadId,
      itemId: null,
      itemKind: null,
      parentToolCallId: "toolu_agent_1",
      data: JSON.stringify({ parentToolCallId: "toolu_agent_1" }),
    },
    {
      threadId: thread.id,
      sequence: 51,
      type: "item/completed",
      scope: turnScope("child-turn"),
      providerThreadId,
      itemId: "child-message",
      itemKind: "agentMessage",
      parentToolCallId: "toolu_agent_1",
      data: JSON.stringify({
        item: {
          type: "agentMessage",
          id: "child-message",
          text: "SECOND_SUBAGENT_OUTPUT",
          parentToolCallId: "toolu_agent_1",
        },
      }),
    },
  ]);
}

function nestedRows(row: TimelineRow): readonly TimelineRow[] {
  if (row.kind === "turn") {
    return row.children ?? [];
  }
  if (row.kind === "work" && row.workKind === "delegation") {
    return row.childRows;
  }
  return [];
}

function flattenRows(rows: readonly TimelineRow[]): TimelineRow[] {
  const flattened: TimelineRow[] = [];
  const visit = (currentRows: readonly TimelineRow[]): void => {
    for (const row of currentRows) {
      flattened.push(row);
      visit(nestedRows(row));
    }
  };
  visit(rows);
  return flattened;
}

function rowTexts(rows: readonly TimelineRow[]): string[] {
  return flattenRows(rows).flatMap((row) =>
    row.kind === "conversation" ? [row.text] : [],
  );
}

describe("thread timeline parented pagination", () => {
  it("keeps child-only subagent output off the latest page", () => {
    const { db, thread } = setup();
    insertCrossWindowSubagentEvents(db, thread);

    const timeline = buildThreadTimeline(db, thread, {
      eventBudget: 1_000_000,
      includeProviderUnhandledOperations: false,
      includeNestedRows: true,
      maxInlineOutputChars: null,
      maxSeq: 51,
      page: { kind: "latest", segmentLimit: 1 },
    });

    expect(rowTexts(timeline.rows)).toContain("Newest response.");
    expect(rowTexts(timeline.rows)).not.toContain("SECOND_SUBAGENT_OUTPUT");
  });

  it("shows cross-window subagent output under the original Agent row", () => {
    const { db, thread } = setup();
    insertCrossWindowSubagentEvents(db, thread);

    const timeline = buildThreadTimeline(db, thread, {
      eventBudget: 1_000_000,
      includeProviderUnhandledOperations: false,
      includeNestedRows: true,
      maxInlineOutputChars: null,
      maxSeq: 51,
      page: {
        kind: "older",
        beforeCursor: {
          anchorId: `${thread.id}:user-seed:20`,
          anchorSeq: 20,
        },
        segmentLimit: 1,
      },
    });
    const delegation = flattenRows(timeline.rows).find(
      (
        row,
      ): row is Extract<
        TimelineRow,
        { kind: "work"; workKind: "delegation" }
      > => row.kind === "work" && row.workKind === "delegation",
    );

    expect(delegation).toBeDefined();
    expect(delegation?.callId).toBe("toolu_agent_1");
    expect(rowTexts(delegation?.childRows ?? [])).toContain(
      "SECOND_SUBAGENT_OUTPUT",
    );
  });
});
