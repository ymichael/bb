import { describe, expect, it } from "vitest";
import {
  encodeClientTurnRequestIdNumber,
  threadScope,
  turnScope,
} from "@bb/domain";
import type { Thread } from "@bb/domain";
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
import { buildThreadTimelineWithProfile } from "../../../src/services/threads/timeline.js";

const providerThreadId = "pi-thread-1";
const PROCESS_EVENT =
  '<process_event kind="success" process_id="proc_551c">Process completed successfully</process_event>';

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
    providerId: "pi",
  });
  return { db, thread };
}

type EventInput = Parameters<typeof insertEvents>[2][number];

function seedExtensionTriggeredTurn(db: DbConnection, thread: Thread): void {
  const events: EventInput[] = [];
  let sequence = 0;
  const push = (event: Omit<EventInput, "sequence" | "threadId">): void => {
    sequence += 1;
    events.push({ ...event, sequence, threadId: thread.id });
  };
  const clientRequestId = encodeClientTurnRequestIdNumber({ value: 1 });
  const providerEvent = (
    type: EventInput["type"],
    turnId: string,
    data: Record<string, unknown>,
    item?: { itemId: string; itemKind: EventInput["itemKind"] },
  ): void => {
    push({
      type,
      scope: turnScope(turnId),
      providerThreadId,
      itemId: item?.itemId ?? null,
      itemKind: item?.itemKind ?? null,
      parentToolCallId: null,
      data: JSON.stringify(data),
    });
  };

  push({
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
      requestId: clientRequestId,
      senderThreadId: null,
      input: [{ type: "text", text: "Reply only with ok.", mentions: [] }],
      target: { kind: "thread-start" },
      execution: {
        model: "gpt-5",
        serviceTier: "default",
        reasoningLevel: "medium",
        permissionMode: "full",
        source: "client/turn/requested",
      },
    }),
  });
  providerEvent("turn/started", "turn-1", {});
  providerEvent("turn/input/accepted", "turn-1", { clientRequestId });
  providerEvent(
    "item/completed",
    "turn-1",
    { item: { type: "agentMessage", id: "assistant-1", text: "ok" } },
    { itemId: "assistant-1", itemKind: "agentMessage" },
  );
  providerEvent("turn/completed", "turn-1", {
    status: "completed",
    providerThreadId,
  });

  providerEvent("turn/started", "turn-2", {});
  providerEvent(
    "item/completed",
    "turn-2",
    {
      item: {
        type: "userMessage",
        id: "provider-input-1",
        content: [{ type: "text", text: PROCESS_EVENT }],
      },
    },
    { itemId: "provider-input-1", itemKind: "userMessage" },
  );
  providerEvent(
    "item/completed",
    "turn-2",
    {
      item: {
        type: "agentMessage",
        id: "assistant-2",
        text: "The process finished.",
      },
    },
    { itemId: "assistant-2", itemKind: "agentMessage" },
  );
  providerEvent("turn/completed", "turn-2", {
    status: "completed",
    providerThreadId,
  });

  insertEvents(db, noopNotifier, events);
}

function conversationTexts(rows: readonly TimelineRow[]): string[] {
  return rows.flatMap((row) => {
    if (row.kind === "conversation") {
      return [`${row.role}:${row.text}`];
    }
    if (row.kind === "turn") {
      return conversationTexts(row.children ?? []);
    }
    return [];
  });
}

describe("timeline pages with provider-recorded input", () => {
  it("keeps the user's earlier turn on the latest page and nests the provider input in its turn", () => {
    const { db, thread } = setup();
    seedExtensionTriggeredTurn(db, thread);

    const { response } = buildThreadTimelineWithProfile(db, thread, {
      eventBudget: 1_000_000,
      includeProviderUnhandledOperations: false,
      includeNestedRows: true,
      maxInlineOutputChars: 32_000,
      maxSeq: 0,
      page: { kind: "latest", segmentLimit: 20 },
    });

    expect(response.timelinePage).toEqual({
      kind: "latest",
      segmentLimit: 20,
      returnedSegmentCount: 1,
      hasOlderRows: false,
      olderCursor: null,
    });
    expect(conversationTexts(response.rows)).toEqual([
      "user:Reply only with ok.",
      "assistant:ok",
      `user:${PROCESS_EVENT}`,
      "assistant:The process finished.",
    ]);
    const turnRow = response.rows.find(
      (row) => row.kind === "turn" && row.turnId === "turn-2",
    );
    expect(turnRow?.kind === "turn" ? turnRow.children : undefined).toEqual([
      expect.objectContaining({
        kind: "conversation",
        role: "user",
        initiator: "system",
        turnRequest: { isGrouped: false, kind: "steer", status: "accepted" },
        text: PROCESS_EVENT,
      }),
    ]);
  });
});
