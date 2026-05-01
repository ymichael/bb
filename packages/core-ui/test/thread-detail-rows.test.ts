import { describe, expect, it } from "vitest";
import {
  buildTimelineRows,
  type BuildTimelineRowsOptions,
  type TimelineRow,
} from "../src/thread-detail-rows.js";
import type {
  ViewMessage,
  ViewProjection,
  ViewTurn,
  ViewTurnStatus,
} from "@bb/domain";
import { threadScope, turnScope } from "@bb/domain";

type TimelineMessageRow = Extract<TimelineRow, { kind: "message" }>;
type TimelineToolBundleRow = Extract<TimelineRow, { kind: "tool-bundle" }>;
type TimelineTurnSummaryRow = Extract<TimelineRow, { kind: "turn-summary" }>;
type ViewAssistantTextMessage = Extract<
  ViewMessage,
  { kind: "assistant-text" }
>;
type ViewDelegationMessage = Extract<ViewMessage, { kind: "delegation" }>;
type ViewErrorMessage = Extract<ViewMessage, { kind: "error" }>;

interface DelegationMessageFixtureArgs {
  id: string;
  sourceSeq: number;
  status?: ViewDelegationMessage["status"];
}

function expectToolBundleRow(
  row: TimelineRow | undefined,
): TimelineToolBundleRow {
  expect(row?.kind).toBe("tool-bundle");
  if (!row || row.kind !== "tool-bundle") {
    throw new Error("Expected a tool-bundle row");
  }
  return row;
}

function expectTurnSummaryRow(
  row: TimelineRow | undefined,
): TimelineTurnSummaryRow {
  expect(row?.kind).toBe("turn-summary");
  if (!row || row.kind !== "turn-summary") {
    throw new Error("Expected a turn-summary row");
  }
  return row;
}

function expectMessageRow(row: TimelineRow | undefined): TimelineMessageRow {
  expect(row?.kind).toBe("message");
  if (!row || row.kind !== "message") {
    throw new Error("Expected a message row");
  }
  return row;
}

function expectAssistantTextMessage(
  message: ViewMessage | undefined,
): ViewAssistantTextMessage {
  expect(message?.kind).toBe("assistant-text");
  if (!message || message.kind !== "assistant-text") {
    throw new Error("Expected an assistant-text message");
  }
  return message;
}

function expectErrorMessage(
  message: ViewMessage | undefined,
): ViewErrorMessage {
  expect(message?.kind).toBe("error");
  if (!message || message.kind !== "error") {
    throw new Error("Expected an error message");
  }
  return message;
}

function getStartedAt(message: ViewMessage): number {
  return message.startedAt ?? message.createdAt;
}

function emptyProjection(): ViewProjection {
  return {
    entries: [],
    state: {
      activeThinking: null,
    },
  };
}

function delegationMessage(
  args: DelegationMessageFixtureArgs,
): ViewDelegationMessage {
  return {
    kind: "delegation",
    id: args.id,
    threadId: "thread-1",
    sourceSeqStart: args.sourceSeq,
    sourceSeqEnd: args.sourceSeq,
    createdAt: args.sourceSeq,
    startedAt: args.sourceSeq,
    turnId: "turn-1",
    toolName: "Agent",
    callId: args.id,
    output: "",
    durationMs: null,
    status: args.status ?? "completed",
    childProjection: emptyProjection(),
  };
}

function collectLeafMessages(rows: readonly TimelineRow[]): ViewMessage[] {
  const messages: ViewMessage[] = [];
  for (const row of rows) {
    switch (row.kind) {
      case "message":
        messages.push(row.message);
        break;
      case "tool-bundle":
      case "assistant-step-summary":
        messages.push(...collectLeafMessages(row.rows));
        break;
      case "turn-summary":
        if (row.rows) {
          messages.push(...collectLeafMessages(row.rows));
        }
        break;
      default:
        break;
    }
  }
  return messages;
}

function getTurnStatus(messages: ViewMessage[]): ViewTurnStatus {
  if (messages.some((message) => message.kind === "error")) {
    return "error";
  }
  if (
    messages.some(
      (message) =>
        "status" in message &&
        (message.status === "pending" || message.status === "streaming"),
    )
  ) {
    return "pending";
  }
  return "completed";
}

function projectionTurnFromMessages(
  turnId: string,
  messages: ViewMessage[],
): ViewTurn {
  const sourceSeqStart = Math.min(
    ...messages.map((message) => message.sourceSeqStart),
  );
  const sourceSeqEnd = Math.max(
    ...messages.map((message) => message.sourceSeqEnd),
  );
  const startedAt = Math.min(
    ...messages.map((message) => getStartedAt(message)),
  );
  const createdAt = Math.max(...messages.map((message) => message.createdAt));
  const status = getTurnStatus(messages);
  return {
    turnId,
    threadId: messages[0]?.threadId ?? "thread-1",
    sourceSeqStart,
    sourceSeqEnd,
    startedAt,
    createdAt,
    completedAt: status === "pending" ? null : createdAt,
    status,
    summaryCount: 0,
    messages,
  };
}

function projectionFromMessages(messages: ViewMessage[]): ViewProjection {
  const entries: ViewProjection["entries"] = [];
  const turnMessagesById = new Map<string, ViewMessage[]>();
  const emittedTurnIds = new Set<string>();

  for (const inputMessage of messages) {
    const message = withFixtureScope(inputMessage);
    if (!message.turnId) {
      entries.push({
        kind: "message",
        message,
      });
      continue;
    }

    const turnMessages = turnMessagesById.get(message.turnId) ?? [];
    turnMessages.push(message);
    turnMessagesById.set(message.turnId, turnMessages);
    if (!emittedTurnIds.has(message.turnId)) {
      emittedTurnIds.add(message.turnId);
      entries.push({
        kind: "turn",
        turn: projectionTurnFromMessages(message.turnId, turnMessages),
      });
    }
  }

  return {
    entries: entries.map((entry) => {
      if (entry.kind === "message") {
        return entry;
      }
      const messagesForTurn = turnMessagesById.get(entry.turn.turnId) ?? [];
      return {
        kind: "turn",
        turn: projectionTurnFromMessages(entry.turn.turnId, messagesForTurn),
      };
    }),
    state: {
      activeThinking: null,
    },
  };
}

function withFixtureScope(message: ViewMessage): ViewMessage {
  const normalizedMessage = withFixtureDefaults(message);
  if (normalizedMessage.scope !== undefined) {
    return normalizedMessage;
  }
  if (normalizedMessage.turnId) {
    return {
      ...normalizedMessage,
      scope: turnScope(normalizedMessage.turnId),
    };
  }
  return {
    ...normalizedMessage,
    scope: threadScope(),
  };
}

function withFixtureDefaults(message: ViewMessage): ViewMessage {
  if (message.kind === "command") {
    return {
      ...message,
      command: message.command ?? "",
      cwd: message.cwd ?? null,
      parsedIntents: message.parsedIntents ?? [],
      source: message.source ?? null,
      output: message.output ?? "",
      exitCode: message.exitCode ?? null,
      durationMs: message.durationMs ?? null,
    };
  }
  if (message.kind === "tool-call") {
    return {
      ...message,
      toolArgs: message.toolArgs ?? null,
      parsedIntents: message.parsedIntents ?? [],
      output: message.output ?? "",
      durationMs: message.durationMs ?? null,
      approvalStatus: message.approvalStatus ?? null,
    };
  }
  if (message.kind === "delegation") {
    return {
      ...message,
      output: message.output ?? "",
      durationMs: message.durationMs ?? null,
    };
  }
  return message;
}

function withProjectionFixtureScopes(
  projection: ViewProjection,
): ViewProjection {
  return {
    entries: projection.entries.map((entry) => {
      if (entry.kind === "message") {
        return {
          kind: "message",
          message: withFixtureScope(entry.message),
        };
      }
      return {
        kind: "turn",
        turn: {
          ...entry.turn,
          messages: entry.turn.messages?.map((message) =>
            withFixtureScope(message),
          ),
          ...(entry.turn.terminalMessage
            ? { terminalMessage: withFixtureScope(entry.turn.terminalMessage) }
            : {}),
        },
      };
    }),
    state: projection.state,
  };
}

function buildRowsFromMessages(
  messages: ViewMessage[],
  options?: BuildTimelineRowsOptions,
): TimelineRow[] {
  return buildTimelineRows(projectionFromMessages(messages), options);
}

function getOperationRows(
  messages: ViewMessage[],
): Array<Extract<ViewMessage, { kind: "operation" }>> {
  return buildRowsFromMessages(messages)
    .filter(
      (row): row is Extract<TimelineRow, { kind: "message" }> =>
        row.kind === "message" && row.message.kind === "operation",
    )
    .map((row) => row.message);
}

describe("buildTimelineRows projection turn lifecycle", () => {
  it("returns no rows for an empty projection", () => {
    expect(buildTimelineRows({ entries: [] })).toEqual([]);
  });

  it("keeps command approval state on the command row", () => {
    const rows = buildRowsFromMessages([
      {
        kind: "command",
        id: "command-waiting",
        threadId: "thread-1",
        turnId: "turn-1",
        sourceSeqStart: 1,
        sourceSeqEnd: 1,
        createdAt: 1,
        callId: "item-1",
        command: "git push",
        status: "pending",
        approvalStatus: "waiting_for_approval",
      },
      {
        kind: "command",
        id: "command-completed",
        threadId: "thread-1",
        turnId: "turn-1",
        sourceSeqStart: 2,
        sourceSeqEnd: 2,
        createdAt: 2,
        callId: "item-1",
        command: "git push",
        status: "completed",
        output: "done",
      },
    ]);

    expect(
      rows.map((row) => (row.kind === "message" ? row.message.id : row.id)),
    ).toEqual(["command-waiting:tool-bundle:1:commands"]);
    const approvalRow = expectToolBundleRow(rows[0]);
    const approvalMessages = collectLeafMessages(approvalRow.rows);
    expect(approvalMessages.map((message) => message.id)).toEqual([
      "command-waiting",
      "command-completed",
    ]);
    expect(approvalMessages[0]).toMatchObject({
      kind: "command",
      command: "git push",
      approvalStatus: "waiting_for_approval",
    });
  });

  it("keeps denied approval state on the command row", () => {
    const rows = buildRowsFromMessages([
      {
        kind: "command",
        id: "command-denied",
        threadId: "thread-1",
        turnId: "turn-1",
        sourceSeqStart: 1,
        sourceSeqEnd: 1,
        createdAt: 1,
        callId: "item-1",
        command: "git push",
        status: "interrupted",
        approvalStatus: "denied",
      },
    ]);

    expect(
      rows.map((row) => (row.kind === "message" ? row.message.id : row.id)),
    ).toEqual(["command-denied:tool-bundle:1:commands"]);
    const deniedRow = expectToolBundleRow(rows[0]);
    const deniedMessages = collectLeafMessages(deniedRow.rows);
    expect(deniedMessages).toHaveLength(1);
    expect(deniedMessages[0]).toMatchObject({
      kind: "command",
      command: "git push",
      approvalStatus: "denied",
    });
  });

  it("keeps a single delegation as an individual row", () => {
    const rows = buildRowsFromMessages([
      delegationMessage({ id: "delegation-1", sourceSeq: 1 }),
    ]);

    expect(rows.map((row) => row.kind)).toEqual(["message"]);
    const row = expectMessageRow(rows[0]);
    expect(row.message.kind).toBe("delegation");
  });

  it("bundles adjacent delegation rows as subagents", () => {
    const rows = buildRowsFromMessages([
      delegationMessage({ id: "delegation-1", sourceSeq: 1 }),
      delegationMessage({ id: "delegation-2", sourceSeq: 2 }),
    ]);

    expect(rows.map((row) => row.kind)).toEqual(["tool-bundle"]);
    const row = expectToolBundleRow(rows[0]);
    expect(row.bundleKind).toBe("delegations");
    expect(row.summary).toEqual({
      kind: "delegations",
      delegations: 2,
    });
    expect(collectLeafMessages(row.rows).map((message) => message.id)).toEqual([
      "delegation-1",
      "delegation-2",
    ]);
  });

  it("collapses a completed turn even when a child message is still pending", () => {
    const projection: ViewProjection = {
      entries: [
        {
          kind: "turn",
          turn: {
            turnId: "turn-1",
            threadId: "thread-1",
            sourceSeqStart: 1,
            sourceSeqEnd: 4,
            startedAt: 1,
            createdAt: 4,
            completedAt: 4,
            status: "completed",
            summaryCount: 1,
            durationMs: 3,
            terminalMessage: {
              kind: "assistant-text",
              id: "assistant-1",
              threadId: "thread-1",
              sourceSeqStart: 3,
              sourceSeqEnd: 3,
              createdAt: 3,
              turnId: "turn-1",
              text: "Done.",
              status: "completed",
            },
            messages: [
              {
                kind: "command",
                id: "tool-1",
                threadId: "thread-1",
                sourceSeqStart: 2,
                sourceSeqEnd: 2,
                createdAt: 2,
                turnId: "turn-1",
                callId: "call-1",
                command: "pnpm test",
                status: "pending",
              },
              {
                kind: "assistant-text",
                id: "assistant-1",
                threadId: "thread-1",
                sourceSeqStart: 3,
                sourceSeqEnd: 3,
                createdAt: 3,
                turnId: "turn-1",
                text: "Done.",
                status: "completed",
              },
            ],
          },
        },
      ],
    };

    const rows = buildTimelineRows(withProjectionFixtureScopes(projection), {
      includeNestedRows: true,
    });

    expect(rows.map((row) => row.kind)).toEqual(["turn-summary", "message"]);
    const toolGroup = expectTurnSummaryRow(rows[0]);
    expect(toolGroup.status).toBe("completed");
    expect(toolGroup.sourceSeqStart).toBe(1);
    expect(toolGroup.sourceSeqEnd).toBe(4);
    expect(collectLeafMessages(toolGroup.rows ?? [])).toHaveLength(1);
    expect(collectLeafMessages(toolGroup.rows ?? [])[0]?.kind).toBe("command");
  });

  it("keeps a pending turn expanded even when all current messages are terminal", () => {
    const projection: ViewProjection = {
      entries: [
        {
          kind: "turn",
          turn: {
            turnId: "turn-1",
            threadId: "thread-1",
            sourceSeqStart: 1,
            sourceSeqEnd: 2,
            startedAt: 1,
            createdAt: 2,
            completedAt: null,
            status: "pending",
            summaryCount: 0,
            terminalMessage: {
              kind: "assistant-text",
              id: "assistant-1",
              threadId: "thread-1",
              sourceSeqStart: 2,
              sourceSeqEnd: 2,
              createdAt: 2,
              turnId: "turn-1",
              text: "Still checking.",
              status: "completed",
            },
            messages: [
              {
                kind: "assistant-text",
                id: "assistant-1",
                threadId: "thread-1",
                sourceSeqStart: 2,
                sourceSeqEnd: 2,
                createdAt: 2,
                turnId: "turn-1",
                text: "Still checking.",
                status: "completed",
              },
            ],
          },
        },
      ],
    };

    const rows = buildTimelineRows(withProjectionFixtureScopes(projection));

    expect(rows.map((row) => row.kind)).toEqual(["message"]);
    const messageRow = expectMessageRow(rows[0]);
    expect(expectAssistantTextMessage(messageRow.message).text).toBe(
      "Still checking.",
    );
  });

  it("keeps messages after the terminal message standalone in a completed turn", () => {
    const projection: ViewProjection = {
      entries: [
        {
          kind: "turn",
          turn: {
            turnId: "turn-1",
            threadId: "thread-1",
            sourceSeqStart: 1,
            sourceSeqEnd: 5,
            startedAt: 1,
            createdAt: 5,
            completedAt: 5,
            status: "completed",
            summaryCount: 2,
            durationMs: 4,
            terminalMessage: {
              kind: "assistant-text",
              id: "assistant-1",
              threadId: "thread-1",
              sourceSeqStart: 3,
              sourceSeqEnd: 3,
              createdAt: 3,
              turnId: "turn-1",
              text: "Done.",
              status: "completed",
            },
            messages: [
              {
                kind: "command",
                id: "tool-1",
                threadId: "thread-1",
                sourceSeqStart: 2,
                sourceSeqEnd: 2,
                createdAt: 2,
                turnId: "turn-1",
                callId: "call-1",
                command: "pnpm test",
                status: "completed",
              },
              {
                kind: "assistant-text",
                id: "assistant-1",
                threadId: "thread-1",
                sourceSeqStart: 3,
                sourceSeqEnd: 3,
                createdAt: 3,
                turnId: "turn-1",
                text: "Done.",
                status: "completed",
              },
              {
                kind: "operation",
                id: "operation-1",
                threadId: "thread-1",
                sourceSeqStart: 4,
                sourceSeqEnd: 4,
                createdAt: 4,
                turnId: "turn-1",
                opType: "operation",
                title: "Follow-up operation",
                status: "completed",
              },
            ],
          },
        },
      ],
    };

    const rows = buildTimelineRows(withProjectionFixtureScopes(projection), {
      includeNestedRows: true,
    });

    expect(rows.map((row) => row.kind)).toEqual([
      "turn-summary",
      "message",
      "message",
    ]);
    const toolGroup = expectTurnSummaryRow(rows[0]);
    expect(
      collectLeafMessages(toolGroup.rows ?? []).map((message) => message.id),
    ).toEqual(["tool-1"]);
    const terminalRow = expectMessageRow(rows[1]);
    expect(terminalRow.message.id).toBe("assistant-1");
    const operationRow = expectMessageRow(rows[2]);
    expect(operationRow.message.id).toBe("operation-1");
  });

  it("does not collapse projection turn messages across a user boundary", () => {
    const projection: ViewProjection = {
      entries: [
        {
          kind: "turn",
          turn: {
            turnId: "turn-1",
            threadId: "thread-1",
            sourceSeqStart: 1,
            sourceSeqEnd: 6,
            startedAt: 1,
            createdAt: 6,
            completedAt: 6,
            status: "completed",
            summaryCount: 2,
            durationMs: 5,
            terminalMessage: {
              kind: "assistant-text",
              id: "assistant-1",
              threadId: "thread-1",
              sourceSeqStart: 5,
              sourceSeqEnd: 5,
              createdAt: 5,
              turnId: "turn-1",
              text: "Done.",
              status: "completed",
            },
            messages: [
              {
                kind: "command",
                id: "tool-1",
                threadId: "thread-1",
                sourceSeqStart: 2,
                sourceSeqEnd: 2,
                createdAt: 2,
                turnId: "turn-1",
                callId: "call-1",
                command: "pnpm test",
                status: "completed",
              },
              {
                kind: "user",
                id: "user-1",
                threadId: "thread-1",
                sourceSeqStart: 3,
                sourceSeqEnd: 3,
                createdAt: 3,
                turnId: "turn-1",
                text: "Actually, run the focused test.",
              },
              {
                kind: "command",
                id: "tool-2",
                threadId: "thread-1",
                sourceSeqStart: 4,
                sourceSeqEnd: 4,
                createdAt: 4,
                turnId: "turn-1",
                callId: "call-2",
                command: "pnpm exec turbo run test --filter=@bb/core-ui",
                status: "completed",
              },
              {
                kind: "assistant-text",
                id: "assistant-1",
                threadId: "thread-1",
                sourceSeqStart: 5,
                sourceSeqEnd: 5,
                createdAt: 5,
                turnId: "turn-1",
                text: "Done.",
                status: "completed",
              },
            ],
          },
        },
      ],
    };

    const rows = buildTimelineRows(withProjectionFixtureScopes(projection), {
      includeNestedRows: true,
    });

    expect(rows.map((row) => row.kind)).toEqual([
      "tool-bundle",
      "message",
      "turn-summary",
      "message",
    ]);
    expect(
      collectLeafMessages([expectToolBundleRow(rows[0])]).map(
        (message) => message.id,
      ),
    ).toEqual(["tool-1"]);
    expect(expectMessageRow(rows[1]).message.id).toBe("user-1");
    const toolGroup = expectTurnSummaryRow(rows[2]);
    expect(
      collectLeafMessages(toolGroup.rows ?? []).map((message) => message.id),
    ).toEqual(["tool-2"]);
    expect(expectMessageRow(rows[3]).message.id).toBe("assistant-1");
  });
});

describe("buildTimelineRows tool group collapsing", () => {
  it("collapses earlier assistant messages before the last terminal into a tool group", () => {
    const rows = buildRowsFromMessages([
      {
        kind: "user",
        id: "user-1",
        threadId: "thread-1",
        sourceSeqStart: 1,
        sourceSeqEnd: 1,
        createdAt: 1,
        turnId: "turn-1",
        text: "say hi",
      },
      {
        kind: "assistant-text",
        id: "assistant-1",
        threadId: "thread-1",
        sourceSeqStart: 2,
        sourceSeqEnd: 2,
        createdAt: 2,
        turnId: "turn-1",
        text: "Hi!",
        status: "completed",
      },
      {
        kind: "assistant-text",
        id: "assistant-2",
        threadId: "thread-1",
        sourceSeqStart: 3,
        sourceSeqEnd: 3,
        createdAt: 3,
        turnId: "turn-1",
        text: "What can I help with?",
        status: "completed",
      },
    ]);

    expect(rows.map((row) => row.kind)).toEqual([
      "message",
      "turn-summary",
      "message",
    ]);
  });

  it("collapses delegation and tasks rows into a tool group before the final assistant text", () => {
    const rows = buildRowsFromMessages([
      {
        kind: "delegation",
        id: "delegation-1",
        threadId: "thread-1",
        sourceSeqStart: 1,
        sourceSeqEnd: 3,
        createdAt: 3,
        startedAt: 1,
        turnId: "turn-1",
        toolName: "Agent",
        callId: "agent-1",
        subagentType: "Explore",
        description: "Search for SearchMenu references",
        output: "Subagent report: found SearchMenu component and tests",
        durationMs: null,
        status: "completed",
        childProjection: emptyProjection(),
      },
      {
        kind: "tasks",
        id: "tasks-1",
        threadId: "thread-1",
        sourceSeqStart: 4,
        sourceSeqEnd: 4,
        createdAt: 4,
        turnId: "turn-1",
        source: "todo",
        title: "Tasks updated",
        status: "completed",
        tasks: [
          { text: "Inspect SearchMenu.tsx", status: "completed" },
          { text: "Add better empty state", status: "active" },
        ],
      },
      {
        kind: "assistant-text",
        id: "assistant-1",
        threadId: "thread-1",
        sourceSeqStart: 5,
        sourceSeqEnd: 5,
        createdAt: 5,
        turnId: "turn-1",
        text: "I found the relevant files and updated the task list.",
        status: "completed",
      },
    ]);

    expect(rows.map((row) => row.kind)).toEqual(["turn-summary", "message"]);
    expect(rows[0]?.kind).toBe("turn-summary");
    if (rows[0]?.kind === "turn-summary") {
      expect(rows[0].summaryCount).toBe(2);
      expect(rows[0].status).toBe("completed");
      expect(collectLeafMessages(rows[0].rows ?? [])).toHaveLength(2);
      expect(collectLeafMessages(rows[0].rows ?? [])[0]?.kind).toBe(
        "delegation",
      );
      expect(collectLeafMessages(rows[0].rows ?? [])[1]?.kind).toBe("tasks");
    }
    expect(rows[1]?.kind).toBe("message");
    if (rows[1]?.kind === "message") {
      expect(rows[1].message.kind).toBe("assistant-text");
    }
  });

  it("keeps intermediate assistant text inside the tool group and the last assistant text standalone", () => {
    const rows = buildRowsFromMessages([
      {
        kind: "user",
        id: "user-1",
        threadId: "thread-1",
        sourceSeqStart: 1,
        sourceSeqEnd: 1,
        createdAt: 1,
        turnId: "turn-1",
        text: "Trace the bug",
      },
      {
        kind: "assistant-text",
        id: "assistant-1",
        threadId: "thread-1",
        sourceSeqStart: 2,
        sourceSeqEnd: 4,
        createdAt: 4,
        turnId: "turn-1",
        text: "I found the likely area.",
        status: "completed",
      },
      {
        kind: "command",
        id: "tool-1",
        threadId: "thread-1",
        sourceSeqStart: 5,
        sourceSeqEnd: 6,
        createdAt: 6,
        turnId: "turn-1",
        callId: "call-1",
        command:
          "rg -n focusIndex packages/excalidraw/components/SearchMenu.tsx",
        status: "completed",
      },
      {
        kind: "assistant-text",
        id: "assistant-2",
        threadId: "thread-1",
        sourceSeqStart: 7,
        sourceSeqEnd: 9,
        createdAt: 9,
        turnId: "turn-1",
        text: "The fix is in SearchMenu.tsx.",
        status: "completed",
      },
    ]);

    expect(rows.map((row) => row.kind)).toEqual([
      "message",
      "turn-summary",
      "message",
    ]);
    const toolGroup = expectTurnSummaryRow(rows[1]);
    expect(
      collectLeafMessages(toolGroup.rows ?? []).map((message) => message.kind),
    ).toEqual(["assistant-text", "command"]);
    const finalRow = expectMessageRow(rows[2]);
    expect(expectAssistantTextMessage(finalRow.message).text).toBe(
      "The fix is in SearchMenu.tsx.",
    );
  });

  it("marks grouped error rows as failed work and counts non-tool rows", () => {
    const rows = buildRowsFromMessages([
      {
        kind: "tasks",
        id: "tasks-1",
        threadId: "thread-1",
        sourceSeqStart: 1,
        sourceSeqEnd: 1,
        createdAt: 1,
        turnId: "turn-1",
        source: "todo",
        title: "Tasks updated",
        status: "completed",
        tasks: [{ text: "Run validation", status: "active" }],
      },
      {
        kind: "error",
        id: "error-1",
        threadId: "thread-1",
        sourceSeqStart: 2,
        sourceSeqEnd: 2,
        createdAt: 2,
        turnId: "turn-1",
        rawType: "provider/error",
        message: "Validation failed",
      },
      {
        kind: "assistant-text",
        id: "assistant-1",
        threadId: "thread-1",
        sourceSeqStart: 3,
        sourceSeqEnd: 3,
        createdAt: 3,
        turnId: "turn-1",
        text: "I hit a validation error.",
        status: "completed",
      },
    ]);

    expect(rows.map((row) => row.kind)).toEqual(["turn-summary", "message"]);
    const toolGroup = expectTurnSummaryRow(rows[0]);
    expect(toolGroup.summaryCount).toBe(2);
    expect(toolGroup.status).toBe("error");
    expect(
      collectLeafMessages(toolGroup.rows ?? []).map((message) => message.kind),
    ).toEqual(["tasks", "error"]);
  });

  it("counts intermediate assistant-text messages in summaryCount", () => {
    const rows = buildRowsFromMessages([
      {
        kind: "assistant-text",
        id: "assistant-1",
        threadId: "thread-1",
        sourceSeqStart: 1,
        sourceSeqEnd: 1,
        createdAt: 1,
        turnId: "turn-1",
        text: "Let me check that.",
        status: "completed",
      },
      {
        kind: "command",
        id: "tool-1",
        threadId: "thread-1",
        sourceSeqStart: 2,
        sourceSeqEnd: 2,
        createdAt: 2,
        turnId: "turn-1",
        callId: "call-1",
        command: "npm test",
        status: "completed",
      },
      {
        kind: "assistant-text",
        id: "assistant-2",
        threadId: "thread-1",
        sourceSeqStart: 3,
        sourceSeqEnd: 3,
        createdAt: 3,
        turnId: "turn-1",
        text: "Tests pass!",
        status: "completed",
      },
    ]);

    expect(rows.map((row) => row.kind)).toEqual(["turn-summary", "message"]);
    const toolGroup = expectTurnSummaryRow(rows[0]);
    expect(toolGroup.summaryCount).toBe(2);
    expect(
      collectLeafMessages(toolGroup.rows ?? []).map((m) => m.kind),
    ).toEqual(["assistant-text", "command"]);
  });

  it("groups pre-terminal messages before the last assistant-text, leaving it standalone", () => {
    const rows = buildRowsFromMessages([
      {
        kind: "assistant-text",
        id: "assistant-1",
        threadId: "thread-1",
        sourceSeqStart: 2,
        sourceSeqEnd: 4,
        createdAt: 4,
        turnId: "turn-1",
        text: "I’m validating the fix now.",
        status: "completed",
      },
      {
        kind: "command",
        id: "tool-1",
        threadId: "thread-1",
        sourceSeqStart: 3,
        sourceSeqEnd: 8,
        createdAt: 8,
        turnId: "turn-1",
        callId: "call-1",
        command: "pnpm exec turbo run test --filter=@bb/core-ui",
        status: "completed",
      },
      {
        kind: "assistant-text",
        id: "assistant-2",
        threadId: "thread-1",
        sourceSeqStart: 5,
        sourceSeqEnd: 6,
        createdAt: 6,
        turnId: "turn-1",
        text: "The tests pass with the fix.",
        status: "completed",
      },
    ]);

    // Last terminal is assistant-2, so assistant-1 + tool-1 get grouped; assistant-2 stays standalone
    expect(rows).toHaveLength(2);
    const toolGroup = expectTurnSummaryRow(rows[0]);
    expect(
      collectLeafMessages(toolGroup.rows ?? []).map((message) => message.kind),
    ).toEqual(["assistant-text", "command"]);
    expectMessageRow(rows[1]);
  });

  it("groups delegation, tasks, and errors together before the final answer", () => {
    const rows = buildRowsFromMessages([
      {
        kind: "delegation",
        id: "delegation-1",
        threadId: "thread-1",
        sourceSeqStart: 1,
        sourceSeqEnd: 2,
        createdAt: 2,
        turnId: "turn-1",
        toolName: "Agent",
        callId: "agent-1",
        status: "completed",
        childProjection: emptyProjection(),
      },
      {
        kind: "tasks",
        id: "tasks-1",
        threadId: "thread-1",
        sourceSeqStart: 3,
        sourceSeqEnd: 3,
        createdAt: 3,
        turnId: "turn-1",
        source: "todo",
        title: "Tasks updated",
        status: "completed",
        tasks: [{ text: "Re-run the focused test", status: "active" }],
      },
      {
        kind: "error",
        id: "error-1",
        threadId: "thread-1",
        sourceSeqStart: 4,
        sourceSeqEnd: 4,
        createdAt: 4,
        turnId: "turn-1",
        rawType: "error",
        message: "Reconnecting... 2/5",
        reconnectAttempt: 2,
        reconnectTotal: 5,
      },
      {
        kind: "assistant-text",
        id: "assistant-1",
        threadId: "thread-1",
        sourceSeqStart: 5,
        sourceSeqEnd: 5,
        createdAt: 5,
        turnId: "turn-1",
        text: "I retried, verified the fix, and updated the task list.",
        status: "completed",
      },
    ]);

    expect(rows.map((row) => row.kind)).toEqual(["turn-summary", "message"]);
    const toolGroup = expectTurnSummaryRow(rows[0]);
    expect(
      collectLeafMessages(toolGroup.rows ?? []).map((message) => message.kind),
    ).toEqual(["delegation", "tasks", "error"]);
  });

  it("groups each turn independently in multi-turn conversations", () => {
    const rows = buildRowsFromMessages([
      {
        kind: "user",
        id: "user-1",
        threadId: "thread-1",
        sourceSeqStart: 1,
        sourceSeqEnd: 1,
        createdAt: 1,
        turnId: "turn-1",
        text: "Fix the bug",
      },
      {
        kind: "tasks",
        id: "tasks-1",
        threadId: "thread-1",
        sourceSeqStart: 2,
        sourceSeqEnd: 2,
        createdAt: 2,
        turnId: "turn-1",
        source: "todo",
        title: "Tasks updated",
        status: "completed",
        tasks: [{ text: "Inspect SearchMenu.tsx", status: "completed" }],
      },
      {
        kind: "command",
        id: "tool-1",
        threadId: "thread-1",
        sourceSeqStart: 3,
        sourceSeqEnd: 3,
        createdAt: 3,
        turnId: "turn-1",
        callId: "call-1",
        command: "pnpm exec turbo run test --filter=@bb/core-ui",
        status: "completed",
      },
      {
        kind: "assistant-text",
        id: "assistant-1",
        threadId: "thread-1",
        sourceSeqStart: 4,
        sourceSeqEnd: 4,
        createdAt: 4,
        turnId: "turn-1",
        text: "Turn one is complete.",
        status: "completed",
      },
      {
        kind: "user",
        id: "user-2",
        threadId: "thread-1",
        sourceSeqStart: 5,
        sourceSeqEnd: 5,
        createdAt: 5,
        turnId: "turn-2",
        text: "Add the summary UI",
      },
      {
        kind: "tasks",
        id: "tasks-2",
        threadId: "thread-1",
        sourceSeqStart: 6,
        sourceSeqEnd: 6,
        createdAt: 6,
        turnId: "turn-2",
        source: "todo",
        title: "Tasks updated",
        status: "completed",
        tasks: [{ text: "Update search summary copy", status: "completed" }],
      },
      {
        kind: "command",
        id: "tool-2",
        threadId: "thread-1",
        sourceSeqStart: 7,
        sourceSeqEnd: 7,
        createdAt: 7,
        turnId: "turn-2",
        callId: "call-2",
        command: "pnpm exec turbo run test --filter=@bb/ui-core",
        status: "completed",
      },
      {
        kind: "assistant-text",
        id: "assistant-2",
        threadId: "thread-1",
        sourceSeqStart: 8,
        sourceSeqEnd: 8,
        createdAt: 8,
        turnId: "turn-2",
        text: "Turn two is complete.",
        status: "completed",
      },
    ]);

    expect(rows.map((row) => row.kind)).toEqual([
      "message",
      "turn-summary",
      "message",
      "message",
      "turn-summary",
      "message",
    ]);
    const toolGroups = rows.filter(
      (row): row is Extract<TimelineRow, { kind: "turn-summary" }> =>
        row.kind === "turn-summary",
    );
    expect(toolGroups).toHaveLength(2);
    expect(toolGroups[0]?.turnId).toBe("turn-1");
    expect(toolGroups[1]?.turnId).toBe("turn-2");
  });

  it("does not collapse a turn that has only one tool message and no terminal", () => {
    const rows = buildRowsFromMessages([
      {
        kind: "user",
        id: "user-1",
        threadId: "thread-1",
        sourceSeqStart: 1,
        sourceSeqEnd: 1,
        createdAt: 1,
        turnId: "turn-1",
        text: "Run the test",
      },
      {
        kind: "command",
        id: "tool-1",
        threadId: "thread-1",
        sourceSeqStart: 2,
        sourceSeqEnd: 2,
        createdAt: 2,
        turnId: "turn-1",
        callId: "call-1",
        command: "pnpm exec turbo run test --filter=@bb/core-ui",
        status: "completed",
      },
    ]);

    expect(rows.map((row) => row.kind)).toEqual(["message", "tool-bundle"]);
  });

  it("does not collapse an active turn before a streaming assistant message", () => {
    const rows = buildRowsFromMessages([
      {
        kind: "user",
        id: "user-1",
        threadId: "thread-1",
        sourceSeqStart: 1,
        sourceSeqEnd: 1,
        createdAt: 1,
        turnId: "turn-1",
        text: "Fix the bug",
      },
      {
        kind: "tasks",
        id: "tasks-1",
        threadId: "thread-1",
        sourceSeqStart: 2,
        sourceSeqEnd: 2,
        createdAt: 2,
        turnId: "turn-1",
        source: "todo",
        title: "Tasks updated",
        status: "completed",
        tasks: [{ text: "Inspect SearchMenu.tsx", status: "completed" }],
      },
      {
        kind: "command",
        id: "tool-1",
        threadId: "thread-1",
        sourceSeqStart: 3,
        sourceSeqEnd: 3,
        createdAt: 3,
        turnId: "turn-1",
        callId: "call-1",
        command: "pnpm exec turbo run test --filter=@bb/core-ui",
        status: "completed",
      },
      {
        kind: "assistant-text",
        id: "assistant-1",
        threadId: "thread-1",
        sourceSeqStart: 4,
        sourceSeqEnd: 4,
        createdAt: 4,
        turnId: "turn-1",
        text: "I am still working on this.",
        status: "streaming",
      },
    ]);

    expect(rows.map((row) => row.kind)).toEqual([
      "message",
      "message",
      "tool-bundle",
      "message",
    ]);
  });

  it("does not wrap a single tool bundle between assistant messages in an assistant-step-summary", () => {
    const rows = buildRowsFromMessages([
      {
        kind: "assistant-text",
        id: "assistant-1",
        threadId: "thread-1",
        sourceSeqStart: 1,
        sourceSeqEnd: 1,
        createdAt: 1,
        turnId: "turn-1",
        text: "I am exploring the codebase.",
        status: "completed",
      },
      {
        kind: "tool-call",
        id: "read-1",
        threadId: "thread-1",
        sourceSeqStart: 2,
        sourceSeqEnd: 2,
        createdAt: 2,
        turnId: "turn-1",
        toolName: "Read",
        callId: "call-1",
        command: "Read /src/main.ts",
        parsedIntents: [
          {
            type: "read",
            cmd: "Read /src/main.ts",
            name: "Read",
            path: "/src/main.ts",
          },
        ],
        output: "contents",
        approvalStatus: null,
        status: "completed",
      },
      {
        kind: "assistant-text",
        id: "assistant-2",
        threadId: "thread-1",
        sourceSeqStart: 3,
        sourceSeqEnd: 3,
        createdAt: 3,
        turnId: "turn-1",
        text: "I found the relevant file.",
        status: "streaming",
      },
    ]);

    expect(rows.map((row) => row.kind)).toEqual([
      "message",
      "tool-bundle",
      "message",
    ]);
    expect(expectToolBundleRow(rows[1]).summary.kind).toBe("exploration");
  });

  it("wraps pre-terminal tool bundles in an assistant-step-summary even without any mid-turn assistant-text", () => {
    const rows = buildRowsFromMessages([
      {
        kind: "command",
        id: "tool-1",
        threadId: "thread-1",
        sourceSeqStart: 1,
        sourceSeqEnd: 1,
        createdAt: 1,
        turnId: "turn-1",
        callId: "call-1",
        command: "git show main:src/a.ts",
        status: "completed",
      },
      {
        kind: "tool-call",
        id: "grep-1",
        threadId: "thread-1",
        sourceSeqStart: 2,
        sourceSeqEnd: 2,
        createdAt: 2,
        turnId: "turn-1",
        toolName: "Grep",
        callId: "call-2",
        command: "Grep foo",
        parsedIntents: [
          {
            type: "search",
            cmd: "Grep foo",
            query: "foo",
            path: null,
          },
        ],
        output: "match",
        approvalStatus: null,
        status: "completed",
      },
      {
        kind: "command",
        id: "tool-3",
        threadId: "thread-1",
        sourceSeqStart: 3,
        sourceSeqEnd: 3,
        createdAt: 3,
        turnId: "turn-1",
        callId: "call-3",
        command: "git show main:src/b.ts",
        status: "completed",
      },
      {
        kind: "command",
        id: "tool-4",
        threadId: "thread-1",
        sourceSeqStart: 4,
        sourceSeqEnd: 4,
        createdAt: 4,
        turnId: "turn-1",
        callId: "call-4",
        command: "git show main:src/c.ts",
        status: "completed",
      },
      {
        kind: "assistant-text",
        id: "assistant-1",
        threadId: "thread-1",
        sourceSeqStart: 5,
        sourceSeqEnd: 5,
        createdAt: 5,
        turnId: "turn-1",
        text: "Here's the summary.",
        status: "completed",
      },
    ]);

    expect(rows.map((row) => row.kind)).toEqual(["turn-summary", "message"]);
    const turnSummary = expectTurnSummaryRow(rows[0]);
    const nested = turnSummary.rows ?? [];
    expect(nested).toHaveLength(1);
    expect(nested[0]?.kind).toBe("assistant-step-summary");
    if (nested[0]?.kind === "assistant-step-summary") {
      expect(nested[0].rows.map((row) => row.kind)).toEqual([
        "tool-bundle",
        "tool-bundle",
        "tool-bundle",
      ]);
    }
  });

  it("keeps assistant text as a boundary between derived exploration bundles", () => {
    const rows = buildRowsFromMessages(
      [
        {
          kind: "tool-call",
          id: "read-1",
          threadId: "thread-1",
          sourceSeqStart: 1,
          sourceSeqEnd: 1,
          createdAt: 1,
          turnId: "turn-1",
          toolName: "Read",
          callId: "call-read",
          command: "Read src/deburr.ts",
          parsedIntents: [
            {
              type: "read",
              cmd: "Read src/deburr.ts",
              name: "Read",
              path: "src/deburr.ts",
            },
          ],
          output: "contents",
          approvalStatus: null,
          status: "completed",
        },
        {
          kind: "assistant-text",
          id: "assistant-1",
          threadId: "thread-1",
          sourceSeqStart: 2,
          sourceSeqEnd: 2,
          createdAt: 2,
          turnId: "turn-1",
          text: "Now let me check the label.",
          status: "completed",
        },
        {
          kind: "tool-call",
          id: "search-1",
          threadId: "thread-1",
          sourceSeqStart: 3,
          sourceSeqEnd: 3,
          createdAt: 3,
          turnId: "turn-1",
          toolName: "Grep",
          callId: "call-search",
          command: "Grep search src/locales/en.json",
          parsedIntents: [
            {
              type: "search",
              cmd: "Grep search src/locales/en.json",
              query: "search",
              path: "src/locales/en.json",
            },
          ],
          output: "match",
          approvalStatus: null,
          status: "completed",
        },
        {
          kind: "command",
          id: "command-1",
          threadId: "thread-1",
          sourceSeqStart: 4,
          sourceSeqEnd: 4,
          createdAt: 4,
          turnId: "turn-1",
          callId: "call-command",
          command: "python3 -c 'print(\"Search\")'",
          output: "Search",
          approvalStatus: null,
          status: "completed",
        },
        {
          kind: "assistant-text",
          id: "assistant-2",
          threadId: "thread-1",
          sourceSeqStart: 5,
          sourceSeqEnd: 5,
          createdAt: 5,
          turnId: "turn-1",
          text: "The label resolves to Search.",
          status: "completed",
        },
      ],
      { includeNestedRows: true },
    );

    expect(rows.map((row) => row.kind)).toEqual(["turn-summary", "message"]);
    const turnSummary = expectTurnSummaryRow(rows[0]);
    const nested = turnSummary.rows ?? [];
    expect(nested.map((row) => row.kind)).toEqual([
      "tool-bundle",
      "message",
      "assistant-step-summary",
    ]);
    expect(collectLeafMessages(nested).map((message) => message.id)).toEqual([
      "read-1",
      "assistant-1",
      "search-1",
      "command-1",
    ]);
    expect(expectMessageRow(rows[1]).message.id).toBe("assistant-2");
  });

  it("marks a single pre-assistant tool bundle as an assistant-step-summary placeholder inside a turn summary", () => {
    const rows = buildRowsFromMessages(
      [
        {
          kind: "command",
          id: "tool-1",
          threadId: "thread-1",
          sourceSeqStart: 1,
          sourceSeqEnd: 1,
          createdAt: 1,
          turnId: "turn-1",
          callId: "call-1",
          command: "git status",
          status: "completed",
        },
        {
          kind: "command",
          id: "tool-2",
          threadId: "thread-1",
          sourceSeqStart: 2,
          sourceSeqEnd: 2,
          createdAt: 2,
          turnId: "turn-1",
          callId: "call-2",
          command: "git diff",
          status: "completed",
        },
        {
          kind: "assistant-text",
          id: "assistant-1",
          threadId: "thread-1",
          sourceSeqStart: 3,
          sourceSeqEnd: 3,
          createdAt: 3,
          turnId: "turn-1",
          text: "Here's the summary of my work.",
          status: "completed",
        },
      ],
      { includeNestedRows: true },
    );

    expect(rows.map((row) => row.kind)).toEqual(["turn-summary", "message"]);
    const turnSummary = expectTurnSummaryRow(rows[0]);
    const nested = turnSummary.rows ?? [];
    expect(nested.map((row) => row.kind)).toEqual(["tool-bundle"]);
    const bundle = expectToolBundleRow(nested[0]);
    expect(bundle.bundleKind).toBe("commands");
    expect(bundle.presentation).toBe("assistant-step-summary-placeholder");
  });

  it("does not collapse an active turn with pending tool work", () => {
    const rows = buildRowsFromMessages([
      {
        kind: "user",
        id: "user-1",
        threadId: "thread-1",
        sourceSeqStart: 1,
        sourceSeqEnd: 1,
        createdAt: 1,
        turnId: "turn-1",
        text: "Run validation",
      },
      {
        kind: "tasks",
        id: "tasks-1",
        threadId: "thread-1",
        sourceSeqStart: 2,
        sourceSeqEnd: 2,
        createdAt: 2,
        turnId: "turn-1",
        source: "todo",
        title: "Tasks updated",
        status: "completed",
        tasks: [{ text: "Run focused tests", status: "active" }],
      },
      {
        kind: "command",
        id: "tool-1",
        threadId: "thread-1",
        sourceSeqStart: 3,
        sourceSeqEnd: 3,
        createdAt: 3,
        turnId: "turn-1",
        callId: "call-1",
        command: "pnpm exec turbo run test --filter=@bb/core-ui",
        status: "pending",
      },
      {
        kind: "assistant-text",
        id: "assistant-1",
        threadId: "thread-1",
        sourceSeqStart: 4,
        sourceSeqEnd: 4,
        createdAt: 4,
        turnId: "turn-1",
        text: "I am waiting for validation.",
        status: "completed",
      },
    ]);

    expect(rows.map((row) => row.kind)).toEqual([
      "message",
      "message",
      "tool-bundle",
      "message",
    ]);
  });

  it("leaves all turn activity standalone when assistant-text is the only terminal message and nothing precedes it to group", () => {
    const rows = buildRowsFromMessages([
      {
        kind: "user",
        id: "user-1",
        threadId: "thread-1",
        sourceSeqStart: 1,
        sourceSeqEnd: 1,
        createdAt: 1,
        turnId: "turn-1",
        text: "Fix the bug",
      },
      {
        kind: "assistant-text",
        id: "assistant-1",
        threadId: "thread-1",
        sourceSeqStart: 2,
        sourceSeqEnd: 2,
        createdAt: 2,
        turnId: "turn-1",
        text: "I found the issue. Now I will validate the fix.",
        status: "completed",
      },
      {
        kind: "command",
        id: "tool-1",
        threadId: "thread-1",
        sourceSeqStart: 3,
        sourceSeqEnd: 3,
        createdAt: 3,
        turnId: "turn-1",
        callId: "call-1",
        command: "npx jest search.test.tsx",
        status: "error",
      },
      {
        kind: "command",
        id: "tool-2",
        threadId: "thread-1",
        sourceSeqStart: 4,
        sourceSeqEnd: 4,
        createdAt: 4,
        turnId: "turn-1",
        callId: "call-2",
        command: "npx vitest run search.test.tsx",
        status: "completed",
      },
    ]);

    // assistant-1 is the last terminal; only user-1 precedes it, but user messages are ungroupable,
    // so no group forms. Everything after the terminal stays standalone too.
    expect(rows.map((row) => row.kind)).toEqual([
      "message",
      "message",
      "tool-bundle",
    ]);
    expect(expectMessageRow(rows[0]).message.kind).toBe("user");
    expect(expectMessageRow(rows[1]).message.kind).toBe("assistant-text");
    expect(expectToolBundleRow(rows[2]).summary.kind).toBe("commands");
  });

  it("leaves messages standalone when the only terminal is first and nothing non-ungroupable precedes it", () => {
    const rows = buildRowsFromMessages([
      {
        kind: "user",
        id: "user-1",
        threadId: "thread-1",
        sourceSeqStart: 1,
        sourceSeqEnd: 1,
        createdAt: 1,
        turnId: "turn-1",
        text: "Fix the bug",
      },
      {
        kind: "assistant-text",
        id: "assistant-1",
        threadId: "thread-1",
        sourceSeqStart: 2,
        sourceSeqEnd: 2,
        createdAt: 2,
        turnId: "turn-1",
        text: "I found the issue. Now I will validate the fix.",
        status: "completed",
      },
      {
        kind: "command",
        id: "tool-1",
        threadId: "thread-1",
        sourceSeqStart: 3,
        sourceSeqEnd: 3,
        createdAt: 3,
        turnId: "turn-1",
        callId: "call-1",
        command: "npx vitest run search.test.tsx",
        status: "completed",
      },
    ]);

    // assistant-1 is the last terminal; only user-1 precedes it (ungroupable), so no group forms.
    // tool-1 is after the terminal and stays standalone.
    expect(rows.map((row) => row.kind)).toEqual([
      "message",
      "message",
      "tool-bundle",
    ]);
    expect(expectMessageRow(rows[0]).message.kind).toBe("user");
    expect(expectMessageRow(rows[1]).message.kind).toBe("assistant-text");
    expect(expectToolBundleRow(rows[2]).summary.kind).toBe("commands");
  });
});

describe("buildTimelineRows reconnect error collapsing", () => {
  it("collapses consecutive reconnect retry errors into the latest row", () => {
    const rows = buildRowsFromMessages([
      {
        kind: "error",
        id: "error-1",
        threadId: "thread-1",
        sourceSeqStart: 10,
        sourceSeqEnd: 10,
        createdAt: 10,
        turnId: "turn-1",
        rawType: "error",
        message: "Reconnecting... 2/5",
        reconnectAttempt: 2,
        reconnectTotal: 5,
      },
      {
        kind: "error",
        id: "error-2",
        threadId: "thread-1",
        sourceSeqStart: 11,
        sourceSeqEnd: 11,
        createdAt: 11,
        turnId: "turn-1",
        rawType: "error",
        message: "Reconnecting... 3/5",
        reconnectAttempt: 3,
        reconnectTotal: 5,
      },
      {
        kind: "error",
        id: "error-3",
        threadId: "thread-1",
        sourceSeqStart: 12,
        sourceSeqEnd: 12,
        createdAt: 12,
        turnId: "turn-1",
        rawType: "error",
        message: "Reconnecting... 4/5",
        reconnectAttempt: 4,
        reconnectTotal: 5,
      },
    ]);

    expect(rows).toHaveLength(1);
    const messageRow = expectMessageRow(rows[0]);
    const errorMessage = expectErrorMessage(messageRow.message);
    expect(errorMessage.id).toBe("error-1");
    expect(errorMessage.message).toBe("Reconnecting... 4/5");
    expect(errorMessage.sourceSeqStart).toBe(10);
    expect(errorMessage.sourceSeqEnd).toBe(12);
    expect(errorMessage.createdAt).toBe(12);
    expect(errorMessage.startedAt).toBe(10);
  });

  it("groups pre-terminal activity before the last error, leaving it standalone", () => {
    const rows = buildRowsFromMessages([
      {
        kind: "error",
        id: "error-1",
        threadId: "thread-1",
        sourceSeqStart: 10,
        sourceSeqEnd: 10,
        createdAt: 10,
        turnId: "turn-1",
        rawType: "error",
        message: "Reconnecting... 2/5",
        reconnectAttempt: 2,
        reconnectTotal: 5,
      },
      {
        kind: "command",
        id: "tool-1",
        threadId: "thread-1",
        sourceSeqStart: 11,
        sourceSeqEnd: 11,
        createdAt: 11,
        turnId: "turn-1",
        callId: "call-1",
        status: "completed",
      },
      {
        kind: "error",
        id: "error-2",
        threadId: "thread-1",
        sourceSeqStart: 12,
        sourceSeqEnd: 12,
        createdAt: 12,
        turnId: "turn-1",
        rawType: "error",
        message: "Reconnecting... 3/4",
        reconnectAttempt: 3,
        reconnectTotal: 4,
      },
      {
        kind: "error",
        id: "error-3",
        threadId: "thread-1",
        sourceSeqStart: 13,
        sourceSeqEnd: 13,
        createdAt: 13,
        turnId: "turn-1",
        rawType: "error",
        message: "Reconnecting... 4/5",
        reconnectAttempt: 4,
        reconnectTotal: 5,
      },
    ]);

    // Last terminal is error-3; error-1, tool-1, error-2 are grouped before it; error-3 stays standalone
    expect(rows).toHaveLength(2);
    expect(rows[0]?.kind).toBe("turn-summary");
    expect(rows[1]?.kind).toBe("message");
  });
});
