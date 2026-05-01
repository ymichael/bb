import type {
  TimelineActivityIntent,
  TimelineConversationAttachments,
  TimelineFileChange,
  TimelineRow,
  TimelineRowBase,
  TimelineRowStatus,
  TimelineSourceRow,
  TimelineTurnRow,
} from "@bb/server-contract";
import type {
  ViewFileEditChange,
  ViewMessage,
  ViewProjection,
  ViewToolParsedIntent,
  ViewTurn,
} from "@bb/domain";
import { assertNever } from "./assert-never.js";
import { getMessageStartedAt } from "./format-helpers.js";
import { getViewMessageScopeTurnId } from "./message-scope.js";
import { formatToolCallCommand } from "./tool-call-parsing.js";

export interface BuildTimelineRowsOptions {
  includeNestedRows?: boolean;
}

interface BuildTurnRowsArgs {
  includeNestedRows: boolean;
  turn: ViewTurn;
}

interface CompletedTurnMessageSlices {
  summaryMessages: ViewMessage[];
  terminalMessages: ViewMessage[];
  trailingMessages: ViewMessage[];
}

function buildTimelineRowBase(message: ViewMessage): TimelineRowBase {
  return {
    id: message.id,
    threadId: message.threadId,
    turnId: getViewMessageScopeTurnId(message),
    sourceSeqStart: message.sourceSeqStart,
    sourceSeqEnd: message.sourceSeqEnd,
    startedAt: getMessageStartedAt(message),
    createdAt: message.createdAt,
  };
}

function toTimelineStatus(
  status: "pending" | "completed" | "error" | "interrupted",
): TimelineRowStatus {
  return status;
}

function toConversationAttachments(
  attachments: Extract<ViewMessage, { kind: "user" }>["attachments"],
): TimelineConversationAttachments | null {
  if (!attachments) {
    return null;
  }
  return {
    webImages: attachments.webImages,
    localImages: attachments.localImages,
    localFiles: attachments.localFiles,
    imageUrls: attachments.imageUrls ?? [],
    localImagePaths: attachments.localImagePaths ?? [],
    localFilePaths: attachments.localFilePaths ?? [],
  };
}

function convertActivityIntent(
  intent: ViewToolParsedIntent,
): TimelineActivityIntent {
  switch (intent.type) {
    case "read":
      return {
        type: "read",
        command: intent.cmd,
        name: intent.name,
        path: intent.path,
      };
    case "list_files":
      return {
        type: "list_files",
        command: intent.cmd,
        path: intent.path,
      };
    case "search":
      return {
        type: "search",
        command: intent.cmd,
        query: intent.query,
        path: intent.path,
      };
    case "unknown":
      return {
        type: "unknown",
        command: intent.cmd,
      };
    default:
      return assertNever(intent);
  }
}

function getDiffStats(
  diff: string | undefined,
): TimelineFileChange["diffStats"] {
  if (!diff) {
    return { added: 0, removed: 0 };
  }
  let added = 0;
  let removed = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) {
      continue;
    }
    if (line.startsWith("+")) {
      added += 1;
      continue;
    }
    if (line.startsWith("-")) {
      removed += 1;
    }
  }
  return { added, removed };
}

function toTimelineFileChange(change: ViewFileEditChange): TimelineFileChange {
  return {
    path: change.path,
    kind: change.kind ?? null,
    movePath: change.movePath ?? null,
    diff: change.diff ?? null,
    diffStats: getDiffStats(change.diff),
  };
}

function convertMessage(message: ViewMessage): TimelineSourceRow[] {
  switch (message.kind) {
    case "user":
      return [
        {
          ...buildTimelineRowBase(message),
          kind: "conversation",
          role: "user",
          text: message.text,
          attachments: toConversationAttachments(message.attachments),
        },
      ];
    case "assistant-text":
      return [
        {
          ...buildTimelineRowBase(message),
          kind: "conversation",
          role: "assistant",
          text: message.text,
          attachments: null,
        },
      ];
    case "command":
      return [
        {
          ...buildTimelineRowBase(message),
          kind: "work",
          workKind: "command",
          status: toTimelineStatus(message.status),
          callId: message.callId,
          command: message.command,
          cwd: message.cwd,
          source: message.source,
          output: message.output,
          exitCode: message.exitCode,
          durationMs: message.durationMs,
          approvalStatus: message.approvalStatus,
          activityIntents: message.parsedIntents.map(convertActivityIntent),
        },
      ];
    case "tool-call":
      return [
        {
          ...buildTimelineRowBase(message),
          kind: "work",
          workKind: "tool",
          status: toTimelineStatus(message.status),
          callId: message.callId,
          toolName: message.toolName,
          toolArgs: message.toolArgs,
          label: formatToolCallCommand(message.toolName, message.toolArgs),
          output: message.output,
          durationMs: message.durationMs,
          approvalStatus: message.approvalStatus,
          activityIntents: message.parsedIntents.map(convertActivityIntent),
        },
      ];
    case "file-edit":
      if (message.changes.length === 0 && message.approvalStatus !== null) {
        return [
          {
            ...buildTimelineRowBase(message),
            kind: "work",
            workKind: "approval",
            status: toTimelineStatus(message.status),
            interactionId: message.callId,
            title:
              message.approvalStatus === "denied"
                ? "Denied file changes"
                : "Waiting for approval to edit files",
            target: {
              itemId: message.callId,
              toolName: null,
            },
          },
        ];
      }
      return message.changes.map((change, index) => ({
        ...buildTimelineRowBase(message),
        id: `${message.id}:file-change:${index}`,
        kind: "work",
        workKind: "file-change",
        status: toTimelineStatus(message.status),
        callId: message.callId,
        change: toTimelineFileChange(change),
        stdout: message.stdout ?? null,
        stderr: message.stderr ?? null,
        approvalStatus: message.approvalStatus,
      }));
    case "web-search":
      return [
        {
          ...buildTimelineRowBase(message),
          kind: "work",
          workKind: "web-search",
          status: toTimelineStatus(message.status),
          callId: message.callId,
          queries: message.queries,
          resultText: message.resultText,
        },
      ];
    case "web-fetch":
      return [
        {
          ...buildTimelineRowBase(message),
          kind: "work",
          workKind: "web-fetch",
          status: toTimelineStatus(message.status),
          callId: message.callId,
          url: message.url,
          prompt: message.prompt,
          pattern: message.pattern,
          resultText: message.resultText,
        },
      ];
    case "delegation":
      return [
        {
          ...buildTimelineRowBase(message),
          kind: "work",
          workKind: "delegation",
          status: toTimelineStatus(message.status),
          callId: message.callId,
          toolName: message.toolName,
          subagentType: message.subagentType ?? null,
          description: message.description ?? null,
          output: message.output,
          durationMs: message.durationMs,
          childRows: buildTimelineRows(message.childProjection, {
            includeNestedRows: true,
          }),
        },
      ];
    case "permission-grant-lifecycle":
      return [
        {
          ...buildTimelineRowBase(message),
          kind: "work",
          workKind: "approval",
          status: toTimelineStatus(message.status),
          interactionId: message.interactionId,
          title: message.title,
          target: message.approvalTarget,
        },
      ];
    case "operation":
      return [
        {
          ...buildTimelineRowBase(message),
          kind: "system",
          systemKind: "operation",
          title: message.title,
          detail: message.detail ?? null,
          status: message.status ? toTimelineStatus(message.status) : null,
        },
      ];
    case "error":
      return [
        {
          ...buildTimelineRowBase(message),
          kind: "system",
          systemKind: message.reconnectAttempt ? "reconnect" : "error",
          title: message.message,
          detail: null,
          status: message.reconnectAttempt ? "pending" : "error",
        },
      ];
    case "debug/raw-event":
      return [
        {
          ...buildTimelineRowBase(message),
          kind: "system",
          systemKind: "debug",
          title: message.rawType,
          detail: JSON.stringify(message.rawEvent),
          status: null,
        },
      ];
    case "tasks":
      return [];
    default:
      return assertNever(message);
  }
}

function isReconnectSystemRow(row: TimelineRow): boolean {
  return row.kind === "system" && row.systemKind === "reconnect";
}

function appendRows(target: TimelineRow[], rows: readonly TimelineRow[]): void {
  for (const row of rows) {
    const previous = target[target.length - 1];
    if (
      previous &&
      isReconnectSystemRow(previous) &&
      isReconnectSystemRow(row)
    ) {
      target[target.length - 1] = row;
      continue;
    }
    target.push(row);
  }
}

function splitCompletedTurnMessages(
  messages: readonly ViewMessage[],
  terminalMessage: ViewMessage | undefined,
): CompletedTurnMessageSlices {
  if (!terminalMessage) {
    return {
      summaryMessages: [...messages],
      terminalMessages: [],
      trailingMessages: [],
    };
  }

  const terminalIndex = messages.findIndex(
    (message) => message.id === terminalMessage.id,
  );
  if (terminalIndex === -1) {
    return {
      summaryMessages: [...messages],
      terminalMessages: [terminalMessage],
      trailingMessages: [],
    };
  }

  const terminalMessageAtIndex = messages[terminalIndex];
  if (!terminalMessageAtIndex) {
    throw new Error(
      `Cannot split completed turn messages at index ${terminalIndex}`,
    );
  }

  return {
    summaryMessages: messages.slice(0, terminalIndex),
    terminalMessages: [terminalMessageAtIndex],
    trailingMessages: messages.slice(terminalIndex + 1),
  };
}

function buildTurnRows({
  includeNestedRows,
  turn,
}: BuildTurnRowsArgs): TimelineRow[] {
  const messages = turn.messages ?? [];
  const isCompletedTurn =
    turn.status !== "pending" && turn.completedAt !== null;

  if (!isCompletedTurn) {
    return messages.flatMap(convertMessage);
  }

  const { summaryMessages, terminalMessages, trailingMessages } =
    splitCompletedTurnMessages(messages, turn.terminalMessage);
  const sourceRows = summaryMessages.flatMap(convertMessage);
  const terminalRows = terminalMessages.flatMap(convertMessage);
  const trailingRows = trailingMessages.flatMap(convertMessage);

  if (turn.summaryCount === 0 && sourceRows.length === 0) {
    return [...terminalRows, ...trailingRows];
  }

  const turnRow: TimelineTurnRow = {
    id: `${turn.threadId}:${turn.turnId}:turn`,
    threadId: turn.threadId,
    turnId: turn.turnId,
    sourceSeqStart: turn.sourceSeqStart,
    sourceSeqEnd: turn.sourceSeqEnd,
    startedAt: turn.startedAt,
    createdAt: turn.createdAt,
    kind: "turn",
    status: turn.status,
    summaryCount: turn.summaryCount,
    durationMs: turn.durationMs ?? null,
    children: includeNestedRows ? sourceRows : null,
  };
  return [turnRow, ...terminalRows, ...trailingRows];
}

export function buildTimelineRows(
  projection: ViewProjection,
  options?: BuildTimelineRowsOptions,
): TimelineRow[] {
  const includeNestedRows = options?.includeNestedRows ?? false;
  const rows: TimelineRow[] = [];

  for (const entry of projection.entries) {
    switch (entry.kind) {
      case "message":
        appendRows(rows, convertMessage(entry.message));
        break;
      case "turn":
        appendRows(
          rows,
          buildTurnRows({
            turn: entry.turn,
            includeNestedRows,
          }),
        );
        break;
      default:
        assertNever(entry);
    }
  }

  return rows;
}

export function buildCollapsedTimelineRows(
  projection: ViewProjection,
  options?: BuildTimelineRowsOptions,
): TimelineRow[] {
  return buildTimelineRows(projection, options);
}
