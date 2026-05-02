import type {
  ThreadContextWindowUsage,
  TimelineActivityIntent,
  TimelineConversationAttachments,
  TimelineFileChange,
  TimelineRow,
  TimelineRowBase,
  TimelineRowStatus,
  TimelineSourceRow,
  TimelineTurnRow,
} from "@bb/server-contract";
import type { ActiveThinking, Thread } from "@bb/domain";
import type {
  EventProjectionFileEditChange,
  EventProjectionMessage,
  EventProjection,
  EventProjectionProvisioningTranscriptEntry,
  EventProjectionToolParsedIntent,
  EventProjectionTurn,
  EventProjectionEntry,
} from "./event-projection-types.js";
import { toPositiveNumber } from "@bb/domain";
import { assertNever } from "./assert-never.js";
import {
  durationToCompactString,
  getMessageStartedAt,
} from "./format-helpers.js";
import { getFileChangeDiffStats } from "./file-change-summary.js";
import { getEventProjectionMessageScopeTurnId } from "./message-scope.js";
import { formatToolCallCommand } from "./tool-call-parsing.js";
import { flattenEventProjectionMessagesDeep } from "./event-projection-flatten.js";
import {
  buildEventProjection,
  buildEventProjectionEntries,
  type ThreadEventWithMeta,
} from "./build-event-projection.js";

export type ThreadTimelineTurnMessageDetail = "summary" | "full";

export type ThreadTimelineViewMode = "standard" | "manager-conversation";

interface ThreadTimelineFromEventsBaseOptions {
  includeDebugRawEvents: boolean;
  includeOptionalOperations: boolean;
  includeProviderUnhandledOperations: boolean;
  threadStatus: Thread["status"];
}

export interface StandardThreadTimelineFromEventsOptions extends ThreadTimelineFromEventsBaseOptions {
  includeNestedRows: boolean;
  turnMessageDetail: ThreadTimelineTurnMessageDetail;
  viewMode: "standard";
}

export interface ManagerConversationTimelineFromEventsOptions extends ThreadTimelineFromEventsBaseOptions {
  viewMode: "manager-conversation";
}

export type ThreadTimelineFromEventsOptions =
  | StandardThreadTimelineFromEventsOptions
  | ManagerConversationTimelineFromEventsOptions;

export interface BuildThreadTimelineFromEventsArgs {
  contextWindowEvents: ThreadEventWithMeta[];
  events: ThreadEventWithMeta[];
  options: ThreadTimelineFromEventsOptions;
}

export interface ThreadTimelineFromEventsResult {
  activeThinking: ActiveThinking | null;
  contextWindowUsage: ThreadContextWindowUsage | null;
  rows: TimelineRow[];
}

export interface ThreadTimelineSourceSeqRange {
  sourceSeqEnd: number;
  sourceSeqStart: number;
}

export interface BuildThreadTimelineTurnDetailsFromEventsOptions extends ThreadTimelineSourceSeqRange {
  includeOptionalOperations: boolean;
  includeProviderUnhandledOperations: boolean;
  threadStatus: Thread["status"];
  viewMode: ThreadTimelineViewMode;
}

export interface BuildThreadTimelineTurnDetailsFromEventsArgs {
  events: ThreadEventWithMeta[];
  options: BuildThreadTimelineTurnDetailsFromEventsOptions;
}

export type ThreadTimelineTurnDetailsFromEventsResult =
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

interface ThreadContextWindowSignal {
  estimated: boolean;
  modelContextWindow: number | null;
  usedTokens: number | null;
}

interface BuildTurnRowsArgs {
  includeNestedRows: boolean;
  rowIdPrefix: string;
  turn: EventProjectionTurn;
}

interface CompletedTurnMessageSlices {
  summaryMessages: EventProjectionMessage[];
  terminalMessages: EventProjectionMessage[];
  trailingMessages: EventProjectionMessage[];
}

interface BuildTimelineRowsOptions {
  includeNestedRows: boolean;
  rowIdPrefix: string;
}

const ROOT_TIMELINE_ROW_ID_PREFIX = "";

type TimelineOperationMessage = Extract<
  EventProjectionMessage,
  { kind: "operation" }
>;

function toNonNegativeNumber(value: number): number | null {
  if (!Number.isFinite(value) || value < 0) {
    return null;
  }
  return value;
}

function decodeContextWindowSignal(
  eventWithMeta: ThreadEventWithMeta,
): ThreadContextWindowSignal | null {
  const { event } = eventWithMeta;
  if (event.type !== "thread/contextWindowUsage/updated") {
    return null;
  }
  const { contextWindowUsage } = event;
  return {
    usedTokens:
      contextWindowUsage.usedTokens === null
        ? null
        : toNonNegativeNumber(contextWindowUsage.usedTokens),
    modelContextWindow:
      contextWindowUsage.modelContextWindow === null
        ? null
        : (toPositiveNumber(contextWindowUsage.modelContextWindow) ?? null),
    estimated: contextWindowUsage.estimated,
  };
}

function extractThreadContextWindowUsage(
  events: readonly ThreadEventWithMeta[],
): ThreadContextWindowUsage | null {
  let estimated: boolean | undefined;
  let modelContextWindow: number | undefined;
  let usedTokens: number | undefined;
  let usageIsUnknown = false;
  const orderedEvents = [...events].sort(
    (left, right) => left.meta.seq - right.meta.seq,
  );

  for (let index = orderedEvents.length - 1; index >= 0; index -= 1) {
    const signal = decodeContextWindowSignal(orderedEvents[index]);
    if (!signal) continue;

    if (usedTokens === undefined && !usageIsUnknown) {
      if (signal.usedTokens === null) {
        usageIsUnknown = true;
        estimated = signal.estimated;
      } else {
        usedTokens = signal.usedTokens;
        estimated = signal.estimated;
      }
    }

    if (
      modelContextWindow === undefined &&
      signal.modelContextWindow !== null
    ) {
      modelContextWindow = signal.modelContextWindow;
    }

    if (
      (usedTokens !== undefined || usageIsUnknown) &&
      modelContextWindow !== undefined
    ) {
      break;
    }
  }

  if (usedTokens === undefined || modelContextWindow === undefined) {
    return null;
  }

  return {
    estimated: estimated ?? false,
    modelContextWindow,
    usedTokens,
  };
}

function buildTimelineRowBase(
  message: EventProjectionMessage,
  rowIdPrefix: string,
): TimelineRowBase {
  return {
    id: `${rowIdPrefix}${message.id}`,
    threadId: message.threadId,
    turnId: getEventProjectionMessageScopeTurnId(message),
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
  attachments: Extract<EventProjectionMessage, { kind: "user" }>["attachments"],
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
  intent: EventProjectionToolParsedIntent,
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

function toTimelineFileChange(
  change: EventProjectionFileEditChange,
): TimelineFileChange {
  return {
    path: change.path,
    kind: change.kind ?? null,
    movePath: change.movePath ?? null,
    diff: change.diff ?? null,
    diffStats: getFileChangeDiffStats(change),
  };
}

function formatProvisioningTranscriptEntry(
  entry: EventProjectionProvisioningTranscriptEntry,
): string {
  const durationMs =
    typeof entry.metadata?.durationMs === "number"
      ? entry.metadata.durationMs
      : null;
  if (
    durationMs !== null &&
    (entry.status === "completed" || entry.status === "failed")
  ) {
    return `${entry.text} (${durationToCompactString(durationMs)})`;
  }
  return entry.text;
}

function provisioningTerminalDetailLine(
  message: TimelineOperationMessage,
): string | null {
  if (
    message.opType !== "thread-provisioning" ||
    message.status === "pending" ||
    message.status === undefined ||
    message.startedAt === undefined ||
    message.createdAt < message.startedAt
  ) {
    return null;
  }

  const elapsedMs = message.createdAt - message.startedAt;
  if (elapsedMs <= 1_000) {
    return null;
  }

  const label =
    message.status === "completed"
      ? "Provisioned thread"
      : message.status === "error"
        ? "Provisioning thread failed"
        : "Provisioning thread interrupted";
  return `${label} (${durationToCompactString(elapsedMs)})`;
}

function buildTimelineOperationDetail(
  message: TimelineOperationMessage,
): string | null {
  if (message.opType !== "thread-provisioning") {
    return message.detail ?? null;
  }

  const transcriptLines =
    message.provisioning?.transcript?.map(formatProvisioningTranscriptEntry) ??
    [];
  const terminalLine = provisioningTerminalDetailLine(message);
  const detailLines = (message.detail ?? "")
    .split(/\n|•/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const lines = [...transcriptLines];
  if (terminalLine) {
    lines.push(terminalLine);
  }
  for (const line of detailLines) {
    if (!lines.includes(line)) {
      lines.push(line);
    }
  }
  return lines.length > 0 ? lines.join("\n") : null;
}

function convertMessage(
  message: EventProjectionMessage,
  options: BuildTimelineRowsOptions,
): TimelineSourceRow[] {
  switch (message.kind) {
    case "user":
      return [
        {
          ...buildTimelineRowBase(message, options.rowIdPrefix),
          kind: "conversation",
          role: "user",
          text: message.text,
          attachments: toConversationAttachments(message.attachments),
        },
      ];
    case "assistant-text":
      return [
        {
          ...buildTimelineRowBase(message, options.rowIdPrefix),
          kind: "conversation",
          role: "assistant",
          text: message.text,
          attachments: null,
        },
      ];
    case "command":
      return [
        {
          ...buildTimelineRowBase(message, options.rowIdPrefix),
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
          ...buildTimelineRowBase(message, options.rowIdPrefix),
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
            ...buildTimelineRowBase(message, options.rowIdPrefix),
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
      return message.changes.map((change, index) => {
        const base = buildTimelineRowBase(message, options.rowIdPrefix);
        return {
          ...base,
          id: `${base.id}:file-change:${index}`,
          kind: "work",
          workKind: "file-change",
          status: toTimelineStatus(message.status),
          callId: message.callId,
          change: toTimelineFileChange(change),
          stdout: message.stdout ?? null,
          stderr: message.stderr ?? null,
          approvalStatus: message.approvalStatus,
        };
      });
    case "web-search":
      return [
        {
          ...buildTimelineRowBase(message, options.rowIdPrefix),
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
          ...buildTimelineRowBase(message, options.rowIdPrefix),
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
      {
        const base = buildTimelineRowBase(message, options.rowIdPrefix);
        return [
          {
            ...base,
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
              rowIdPrefix: `${base.id}:child:`,
            }),
          },
        ];
      }
    case "permission-grant-lifecycle":
      return [
        {
          ...buildTimelineRowBase(message, options.rowIdPrefix),
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
          ...buildTimelineRowBase(message, options.rowIdPrefix),
          kind: "system",
          systemKind: "operation",
          title: message.title,
          detail: buildTimelineOperationDetail(message),
          status: message.status ? toTimelineStatus(message.status) : null,
        },
      ];
    case "error":
      return [
        {
          ...buildTimelineRowBase(message, options.rowIdPrefix),
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
          ...buildTimelineRowBase(message, options.rowIdPrefix),
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
  messages: readonly EventProjectionMessage[],
  terminalMessage: EventProjectionMessage | undefined,
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
  rowIdPrefix,
  turn,
}: BuildTurnRowsArgs): TimelineRow[] {
  const messages = turn.messages ?? [];
  const isCompletedTurn =
    turn.status !== "pending" && turn.completedAt !== null;

  if (!isCompletedTurn) {
    return messages.flatMap((message) =>
      convertMessage(message, { includeNestedRows, rowIdPrefix }),
    );
  }

  const { summaryMessages, terminalMessages, trailingMessages } =
    splitCompletedTurnMessages(messages, turn.terminalMessage);
  const sourceRows = summaryMessages.flatMap((message) =>
    convertMessage(message, { includeNestedRows, rowIdPrefix }),
  );
  const terminalRows = terminalMessages.flatMap((message) =>
    convertMessage(message, { includeNestedRows, rowIdPrefix }),
  );
  const trailingRows = trailingMessages.flatMap((message) =>
    convertMessage(message, { includeNestedRows, rowIdPrefix }),
  );

  if (turn.summaryCount === 0 && sourceRows.length === 0) {
    return [...terminalRows, ...trailingRows];
  }

  const turnRow: TimelineTurnRow = {
    id: `${rowIdPrefix}${turn.threadId}:${turn.turnId}:turn`,
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
function isManagerConversationMessage(
  message: EventProjectionMessage,
): boolean {
  if (message.kind === "user") return true;
  if (message.kind === "operation") return true;
  return (
    message.kind === "assistant-text" && message.isManagerUserMessage === true
  );
}

function buildManagerConversationRows(
  projection: EventProjection,
): TimelineRow[] {
  const entries: EventProjectionEntry[] = flattenEventProjectionMessagesDeep(
    projection,
  )
    .filter(isManagerConversationMessage)
    .map((message) => ({ kind: "projected-message", message }));
  return buildTimelineRows(
    {
      entries,
      state: projection.state,
    },
    {
      includeNestedRows: false,
      rowIdPrefix: ROOT_TIMELINE_ROW_ID_PREFIX,
    },
  );
}

type TimelineTurnSummaryRow = Extract<TimelineRow, { kind: "turn" }>;

function findMatchingTurnSummaryRow(
  rows: TimelineRow[],
  range: ThreadTimelineSourceSeqRange,
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

function buildTimelineRows(
  projection: EventProjection,
  options: BuildTimelineRowsOptions,
): TimelineRow[] {
  const { includeNestedRows } = options;
  const rows: TimelineRow[] = [];

  for (const entry of projection.entries) {
    switch (entry.kind) {
      case "projected-message":
        appendRows(rows, convertMessage(entry.message, options));
        break;
      case "turn":
        appendRows(
          rows,
          buildTurnRows({
            turn: entry.turn,
            includeNestedRows,
            rowIdPrefix: options.rowIdPrefix,
          }),
        );
        break;
      default:
        assertNever(entry);
    }
  }

  return rows;
}

export function buildThreadTimelineFromEvents(
  args: BuildThreadTimelineFromEventsArgs,
): ThreadTimelineFromEventsResult {
  const projectionOptions = {
    includeDebugRawEvents: args.options.includeDebugRawEvents,
    includeOptionalOperations: args.options.includeOptionalOperations,
    includeProviderUnhandledOperations:
      args.options.includeProviderUnhandledOperations,
    threadStatus: args.options.threadStatus,
    threadType:
      args.options.viewMode === "manager-conversation" ? "manager" : "standard",
    turnMessageDetail:
      args.options.viewMode === "manager-conversation"
        ? "full"
        : args.options.turnMessageDetail,
  } satisfies Parameters<typeof buildEventProjection>[1];
  const projection =
    args.options.viewMode === "manager-conversation"
      ? buildEventProjectionEntries(args.events, projectionOptions)
      : buildEventProjection(args.events, projectionOptions);

  return {
    activeThinking:
      args.options.viewMode === "manager-conversation"
        ? null
        : projection.state.activeThinking,
    contextWindowUsage: extractThreadContextWindowUsage(
      args.contextWindowEvents,
    ),
    rows:
      args.options.viewMode === "manager-conversation"
        ? buildManagerConversationRows(projection)
        : buildTimelineRows(projection, {
            includeNestedRows: args.options.includeNestedRows,
            rowIdPrefix: ROOT_TIMELINE_ROW_ID_PREFIX,
          }),
  };
}

export function buildThreadTimelineTurnDetailsFromEvents(
  args: BuildThreadTimelineTurnDetailsFromEventsArgs,
): ThreadTimelineTurnDetailsFromEventsResult {
  const projection = buildEventProjectionEntries(args.events, {
    includeDebugRawEvents: false,
    includeOptionalOperations: args.options.includeOptionalOperations,
    includeProviderUnhandledOperations:
      args.options.includeProviderUnhandledOperations,
    threadStatus: args.options.threadStatus,
    threadType:
      args.options.viewMode === "manager-conversation" ? "manager" : "standard",
    turnMessageDetail: "full",
  });
  const nestedRows = buildTimelineRows(projection, {
    includeNestedRows: true,
    rowIdPrefix: ROOT_TIMELINE_ROW_ID_PREFIX,
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
