import { turnScope } from "@bb/domain";
import type {
  JsonObject,
  ThreadEventFileChange,
  ThreadEventItemStatus,
} from "@bb/domain";
import type {
  ThreadContextWindowUsage,
  TimelineFileChangeWorkRow,
  TimelineRow,
  TimelineToolWorkRow,
} from "@bb/server-contract";
import { describe, expect, it } from "vitest";
import {
  buildThreadTimelineFromEvents,
  type ThreadEventWithMeta,
} from "../src/index.js";

interface ContextWindowUsageEventArgs {
  estimated: boolean;
  modelContextWindow: number | null;
  seq: number;
  usedTokens: number | null;
}

interface FileChangeItemEventArgs {
  changes: ThreadEventFileChange[];
  itemId?: string;
  seq: number;
  status?: ThreadEventItemStatus;
  type: "item/completed" | "item/started";
}

interface ToolCallItemEventArgs {
  itemId?: string;
  result?: string;
  seq: number;
  status?: ThreadEventItemStatus;
  tool: string;
  toolArgs?: JsonObject;
  type: "item/completed" | "item/started";
}

interface TurnStartedEventArgs {
  seq: number;
}

function contextWindowUsageEvent({
  estimated,
  modelContextWindow,
  seq,
  usedTokens,
}: ContextWindowUsageEventArgs): ThreadEventWithMeta {
  return {
    event: {
      type: "thread/contextWindowUsage/updated",
      threadId: "thread-1",
      providerThreadId: "provider-thread-1",
      scope: turnScope(`turn-${seq}`),
      contextWindowUsage: {
        estimated,
        modelContextWindow,
        usedTokens,
      },
    },
    meta: {
      id: `event-${seq}`,
      seq,
      createdAt: seq,
    },
  };
}

function fileChangeItemEvent({
  changes,
  itemId = "file-edit-1",
  seq,
  status,
  type,
}: FileChangeItemEventArgs): ThreadEventWithMeta {
  return {
    event: {
      type,
      threadId: "thread-1",
      providerThreadId: "provider-thread-1",
      scope: turnScope("turn-1"),
      item: {
        type: "fileChange",
        id: itemId,
        changes,
        status: status ?? (type === "item/completed" ? "completed" : "pending"),
        approvalStatus: null,
      },
    },
    meta: {
      id: `event-${seq}`,
      seq,
      createdAt: seq,
    },
  };
}

function toolCallItemEvent({
  itemId = "tool-call-1",
  result,
  seq,
  status,
  tool,
  toolArgs,
  type,
}: ToolCallItemEventArgs): ThreadEventWithMeta {
  return {
    event: {
      type,
      threadId: "thread-1",
      providerThreadId: "provider-thread-1",
      scope: turnScope("turn-1"),
      item: {
        type: "toolCall",
        id: itemId,
        tool,
        ...(toolArgs ? { arguments: toolArgs } : {}),
        status: status ?? (type === "item/completed" ? "completed" : "pending"),
        ...(result ? { result } : {}),
      },
    },
    meta: {
      id: `event-${seq}`,
      seq,
      createdAt: seq,
    },
  };
}

function turnStartedEvent({ seq }: TurnStartedEventArgs): ThreadEventWithMeta {
  return {
    event: {
      type: "turn/started",
      threadId: "thread-1",
      providerThreadId: "provider-thread-1",
      scope: turnScope("turn-1"),
    },
    meta: {
      id: `event-${seq}`,
      seq,
      createdAt: seq,
    },
  };
}

function buildContextWindowUsage(
  contextWindowEvents: ThreadEventWithMeta[],
): ThreadContextWindowUsage | null {
  return buildThreadTimelineFromEvents({
    contextWindowEvents,
    events: [],
    options: {
      includeDebugRawEvents: false,
      includeNestedRows: false,
      includeOptionalOperations: false,
      includeProviderUnhandledOperations: false,
      systemClientRequestVisibility: "hidden",
      threadStatus: "idle",
      turnMessageDetail: "summary",
      viewMode: "standard",
    },
  }).contextWindowUsage;
}

function buildTimelineRows(events: ThreadEventWithMeta[]): TimelineRow[] {
  return buildThreadTimelineFromEvents({
    contextWindowEvents: [],
    events,
    options: {
      includeDebugRawEvents: false,
      includeNestedRows: true,
      includeOptionalOperations: false,
      includeProviderUnhandledOperations: false,
      systemClientRequestVisibility: "hidden",
      threadStatus: "idle",
      turnMessageDetail: "full",
      viewMode: "standard",
    },
  }).rows;
}

function isFileChangeRow(row: TimelineRow): row is TimelineFileChangeWorkRow {
  return row.kind === "work" && row.workKind === "file-change";
}

function isToolRow(row: TimelineRow): row is TimelineToolWorkRow {
  return row.kind === "work" && row.workKind === "tool";
}

function collectFileChangeRows(
  rows: readonly TimelineRow[],
): TimelineFileChangeWorkRow[] {
  const fileChangeRows: TimelineFileChangeWorkRow[] = [];
  for (const row of rows) {
    if (isFileChangeRow(row)) {
      fileChangeRows.push(row);
      continue;
    }
    if (row.kind === "turn" && row.children) {
      fileChangeRows.push(...collectFileChangeRows(row.children));
      continue;
    }
    if (row.kind === "work" && row.workKind === "delegation") {
      fileChangeRows.push(...collectFileChangeRows(row.childRows));
    }
  }
  return fileChangeRows;
}

function collectToolRows(rows: readonly TimelineRow[]): TimelineToolWorkRow[] {
  const toolRows: TimelineToolWorkRow[] = [];
  for (const row of rows) {
    if (isToolRow(row)) {
      toolRows.push(row);
      continue;
    }
    if (row.kind === "turn" && row.children) {
      toolRows.push(...collectToolRows(row.children));
      continue;
    }
    if (row.kind === "work" && row.workKind === "delegation") {
      toolRows.push(...collectToolRows(row.childRows));
    }
  }
  return toolRows;
}

function fileChangeRowIdByPath(
  rows: readonly TimelineFileChangeWorkRow[],
): Record<string, string> {
  const idByPath: Record<string, string> = {};
  for (const row of rows) {
    idByPath[row.change.path] = row.id;
  }
  return idByPath;
}

describe("buildThreadTimelineFromEvents", () => {
  it("suppresses low-value ToolSearch rows", () => {
    const rows = buildTimelineRows([
      turnStartedEvent({ seq: 0 }),
      toolCallItemEvent({
        seq: 1,
        tool: "ToolSearch",
        toolArgs: { query: "select:TodoWrite", max_results: 1 },
        type: "item/started",
      }),
      toolCallItemEvent({
        result: "Matched tools: TodoWrite",
        seq: 2,
        tool: "ToolSearch",
        toolArgs: { query: "select:TodoWrite", max_results: 1 },
        type: "item/completed",
      }),
    ]);

    expect(collectToolRows(rows)).toEqual([]);
    expect(JSON.stringify(rows)).not.toContain("Matched tools: TodoWrite");
  });

  it("extracts context-window usage from ordered events", () => {
    expect(
      buildContextWindowUsage([
        contextWindowUsageEvent({
          estimated: false,
          modelContextWindow: 200_000,
          seq: 1,
          usedTokens: 120,
        }),
        contextWindowUsageEvent({
          estimated: true,
          modelContextWindow: null,
          seq: 2,
          usedTokens: 60,
        }),
      ]),
    ).toEqual({
      estimated: true,
      modelContextWindow: 200_000,
      usedTokens: 60,
    });
  });

  it("extracts context-window usage from unordered events", () => {
    expect(
      buildContextWindowUsage([
        contextWindowUsageEvent({
          estimated: true,
          modelContextWindow: null,
          seq: 2,
          usedTokens: 60,
        }),
        contextWindowUsageEvent({
          estimated: false,
          modelContextWindow: 200_000,
          seq: 1,
          usedTokens: 120,
        }),
      ]),
    ).toEqual({
      estimated: true,
      modelContextWindow: 200_000,
      usedTokens: 60,
    });
  });

  it("keeps file-change row identity stable when provider changes reorder", () => {
    const initialChanges: ThreadEventFileChange[] = [
      {
        path: "src/a.ts",
        kind: "update",
        diff: "@@ -1 +1 @@\n-old a\n+new a",
      },
      {
        path: "src/b.ts",
        kind: "update",
        diff: "@@ -1 +1 @@\n-old b\n+new b",
      },
    ];
    const reorderedChanges = [initialChanges[1], initialChanges[0]].filter(
      (change): change is ThreadEventFileChange => Boolean(change),
    );
    const startedEvent = fileChangeItemEvent({
      changes: initialChanges,
      seq: 1,
      type: "item/started",
    });
    const turnStarted = turnStartedEvent({ seq: 0 });

    const initialRows = collectFileChangeRows(
      buildTimelineRows([turnStarted, startedEvent]),
    );
    const finalRows = collectFileChangeRows(
      buildTimelineRows([
        turnStarted,
        startedEvent,
        fileChangeItemEvent({
          changes: reorderedChanges,
          seq: 2,
          type: "item/completed",
        }),
      ]),
    );

    expect(fileChangeRowIdByPath(finalRows)).toEqual(
      fileChangeRowIdByPath(initialRows),
    );
  });

  it("drops stale file-change rows that are missing from later provider changes", () => {
    const startedEvent = fileChangeItemEvent({
      changes: [
        {
          path: "src/a.ts",
          kind: "update",
          diff: "@@ -1 +1 @@\n-old a\n+new a",
        },
        {
          path: "src/b.ts",
          kind: "update",
          diff: "@@ -1 +1 @@\n-old b\n+new b",
        },
      ],
      seq: 1,
      type: "item/started",
    });
    const turnStarted = turnStartedEvent({ seq: 0 });
    const finalRows = collectFileChangeRows(
      buildTimelineRows([
        turnStarted,
        startedEvent,
        fileChangeItemEvent({
          changes: [
            {
              path: "src/a.ts",
              kind: "update",
              diff: "@@ -1 +1 @@\n-old a\n+newer a",
            },
          ],
          seq: 2,
          type: "item/completed",
        }),
      ]),
    );

    expect(finalRows.map((row) => row.change.path)).toEqual(["src/a.ts"]);
  });

  it("keeps file-change row identity stable when movePath appears later", () => {
    const startedEvent = fileChangeItemEvent({
      changes: [
        {
          path: "src/old.ts",
          kind: "update",
          diff: "@@ -1 +1 @@\n-old\n+new",
        },
      ],
      seq: 1,
      type: "item/started",
    });
    const turnStarted = turnStartedEvent({ seq: 0 });

    const initialRows = collectFileChangeRows(
      buildTimelineRows([turnStarted, startedEvent]),
    );
    const finalRows = collectFileChangeRows(
      buildTimelineRows([
        turnStarted,
        startedEvent,
        fileChangeItemEvent({
          changes: [
            {
              path: "src/old.ts",
              kind: "update",
              movePath: "src/new.ts",
              diff: "@@ -1 +1 @@\n-old\n+new",
            },
          ],
          seq: 2,
          type: "item/completed",
        }),
      ]),
    );

    expect(finalRows).toHaveLength(1);
    expect(finalRows[0]?.id).toBe(initialRows[0]?.id);
    expect(finalRows[0]?.change).toMatchObject({
      path: "src/old.ts",
      movePath: "src/new.ts",
    });
  });
});
