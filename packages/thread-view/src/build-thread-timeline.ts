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
  ActiveThinking,
  Thread,
  ViewFileEditChange,
  ViewMessage,
  ViewProjection,
  ViewToolParsedIntent,
  ViewTurn,
  ViewTimelineEntry,
} from "@bb/domain";
import { assertNever } from "./assert-never.js";
import { getMessageStartedAt } from "./format-helpers.js";
import { getViewMessageScopeTurnId } from "./message-scope.js";
import { formatToolCallCommand } from "./tool-call-parsing.js";
import { flattenProjectionMessagesDeep } from "./projection-flatten.js";
import {
  toViewProjection,
  toViewProjectionEntries,
  type ThreadEventWithMeta,
} from "./to-view-messages.js";

export interface BuildTimelineRowsOptions {
  includeNestedRows?: boolean;
}

export type TimelineTurnMessageDetail = "summary" | "full";

export interface TimelineRowsFromEventsOptions {
  includeDebugRawEvents?: boolean;
  includeInternalSystemMessages?: boolean;
  includeNestedRows?: boolean;
  includeOptionalOperations?: boolean;
  includeProviderUnhandledOperations?: boolean;
  threadStatus?: Thread["status"];
  threadType?: Thread["type"];
  turnMessageDetail: TimelineTurnMessageDetail;
}

export interface BuildTimelineRowsFromEventsArgs {
  events: ThreadEventWithMeta[];
  options: TimelineRowsFromEventsOptions;
}

export interface TimelineRowsFromEventsResult {
  activeThinking: ActiveThinking | null;
  rows: TimelineRow[];
}

export type ManagerTimelineRowsFromEventsOptions = Omit<
  TimelineRowsFromEventsOptions,
  "includeNestedRows"
>;

export interface BuildManagerTimelineRowsFromEventsArgs {
  events: ThreadEventWithMeta[];
  options: ManagerTimelineRowsFromEventsOptions;
}

export interface TimelineSourceSeqRange {
  sourceSeqEnd: number;
  sourceSeqStart: number;
}

export interface ResolveTimelineTurnSummaryDetailsFromEventsArgs {
  events: ThreadEventWithMeta[];
  options: ManagerTimelineRowsFromEventsOptions & TimelineSourceSeqRange;
}

export type TimelineTurnSummaryDetailsResolution =
  | {
      kind: "matched";
      rows: TimelineRow[];
    }
  | {
      kind: "missing-match";
    }
  | {
      kind: "ungrouped";
      rows: TimelineRow[];
    };

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

/**
 * For manager threads in the default (non-debug) view, only show user messages,
 * message_user output, and lifecycle operations (provisioning, compaction).
 * Everything else (assistant text, delegations, other tool calls, etc.) is
 * internal manager machinery.
 */
function isManagerConversationMessage(message: ViewMessage): boolean {
  if (message.kind === "user") return true;
  if (message.kind === "operation") return true;
  return (
    message.kind === "assistant-text" &&
    message.isManagerUserMessage === true
  );
}

function buildManagerConversationRows(
  projection: ViewProjection,
): TimelineRow[] {
  const entries: ViewTimelineEntry[] = flattenProjectionMessagesDeep(projection)
    .filter(isManagerConversationMessage)
    .map((message) => ({ kind: "message", message }));
  return buildTimelineRows({
    entries,
    state: projection.state,
  });
}

type TimelineTurnSummaryRow = Extract<TimelineRow, { kind: "turn" }>;

function findMatchingTurnSummaryRow(
  rows: TimelineRow[],
  range: TimelineSourceSeqRange,
): TimelineTurnSummaryRow | null {
  return (
    rows.find(
      (row): row is TimelineTurnSummaryRow =>
        row.kind === "turn" &&
        row.sourceSeqStart === range.sourceSeqStart &&
        row.sourceSeqEnd === range.sourceSeqEnd,
    ) ?? null
  );
}

function hasTurnSummaryRows(rows: TimelineRow[]): boolean {
  return rows.some((row) => row.kind === "turn");
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

export function buildTimelineRowsFromEvents(
  args: BuildTimelineRowsFromEventsArgs,
): TimelineRowsFromEventsResult {
  const projection = toViewProjection(args.events, {
    includeDebugRawEvents: args.options.includeDebugRawEvents,
    includeInternalSystemMessages: args.options.includeInternalSystemMessages,
    includeOptionalOperations: args.options.includeOptionalOperations,
    includeProviderUnhandledOperations:
      args.options.includeProviderUnhandledOperations,
    threadStatus: args.options.threadStatus,
    threadType: args.options.threadType,
    turnMessageDetail: args.options.turnMessageDetail,
  });
  return {
    activeThinking: projection.state.activeThinking,
    rows: buildTimelineRows(projection, {
      includeNestedRows: args.options.includeNestedRows,
    }),
  };
}

export function buildManagerTimelineRowsFromEvents(
  args: BuildManagerTimelineRowsFromEventsArgs,
): TimelineRowsFromEventsResult {
  const projection = toViewProjectionEntries(args.events, {
    includeDebugRawEvents: args.options.includeDebugRawEvents,
    includeInternalSystemMessages: args.options.includeInternalSystemMessages,
    includeOptionalOperations: args.options.includeOptionalOperations,
    includeProviderUnhandledOperations:
      args.options.includeProviderUnhandledOperations,
    threadStatus: args.options.threadStatus,
    threadType: args.options.threadType,
    turnMessageDetail: args.options.turnMessageDetail,
  });
  return {
    activeThinking: null,
    rows: buildManagerConversationRows(projection),
  };
}

export function resolveTimelineTurnSummaryDetailsFromEvents(
  args: ResolveTimelineTurnSummaryDetailsFromEventsArgs,
): TimelineTurnSummaryDetailsResolution {
  const projection = toViewProjectionEntries(args.events, {
    includeDebugRawEvents: args.options.includeDebugRawEvents,
    includeInternalSystemMessages: args.options.includeInternalSystemMessages,
    includeOptionalOperations: args.options.includeOptionalOperations,
    includeProviderUnhandledOperations:
      args.options.includeProviderUnhandledOperations,
    threadStatus: args.options.threadStatus,
    threadType: args.options.threadType,
    turnMessageDetail: args.options.turnMessageDetail,
  });
  const nestedRows = buildTimelineRows(projection, {
    includeNestedRows: true,
  });
  const matchingTurnSummary = findMatchingTurnSummaryRow(
    nestedRows,
    args.options,
  );
  if (matchingTurnSummary) {
    return {
      kind: "matched",
      rows: matchingTurnSummary.children ?? [],
    };
  }

  if (hasTurnSummaryRows(nestedRows)) {
    return {
      kind: "missing-match",
    };
  }

  return {
    kind: "ungrouped",
    rows: nestedRows,
  };
}
