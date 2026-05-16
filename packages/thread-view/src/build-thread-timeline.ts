import type {
  ThreadContextWindowUsage,
  TimelineActivityIntent,
  TimelineConversationAttachments,
  TimelineFileChange,
  TimelineManagerAssignment,
  TimelineRow,
  TimelineRowBase,
  TimelineRowStatus,
  TimelineSourceRow,
  TimelineSystemOperationKind,
  TimelineSystemRow,
  TimelineTurnRow,
  TimelineUserConversationRow,
} from "@bb/server-contract";
import type {
  ActiveThinking,
  Thread,
  ThreadEventItemType,
  ThreadEventType,
  ThreadTimelinePendingTodos,
} from "@bb/domain";
import type {
  EventProjectionFileEditChange,
  EventProjectionMessage,
  EventProjection,
  EventProjectionProvisioningTranscriptEntry,
  EventProjectionToolParsedIntent,
  EventProjectionTurn,
  EventProjectionEntry,
  SystemClientRequestVisibility,
} from "./event-projection-types.js";
import { assertNever } from "./assert-never.js";
import {
  durationToCompactString,
  getMessageStartedAt,
} from "./format-helpers.js";
import { getFileChangeDiffStats } from "./file-change-summary.js";
import { getEventProjectionMessageScopeTurnId } from "./message-scope.js";
import { flattenEventProjectionMessagesDeep } from "./event-projection-flatten.js";
import {
  buildEventProjection,
  buildEventProjectionEntries,
  type ThreadEventWithMeta,
} from "./build-event-projection.js";
import {
  buildAcceptedClientRequestById,
  parsePendingSteerFromClientRequest,
} from "./user-message-parsing.js";
import { getOrderedThreadEvents } from "./group-event-projection-turns.js";
import {
  groupCompletedTurnMessages,
  type CompletedTurnSummaryItem,
} from "./completed-turn-grouping.js";
import { extractThreadContextWindowUsage } from "./thread-context-window-usage.js";
import { extractThreadTimelinePendingTodos } from "./todo-snapshot-extraction.js";

export type ThreadTimelineTurnMessageDetail = "summary" | "full";

export type ThreadTimelineViewMode = "standard" | "manager-conversation";

export interface ThreadTimelineEventSelection {
  eventTypes: readonly ThreadEventType[];
  itemEventTypes: readonly ThreadEventType[];
  itemKinds: readonly ThreadEventItemType[];
}

export const MANAGER_CONVERSATION_TIMELINE_EVENT_SELECTION = {
  eventTypes: [
    "client/turn/requested",
    "provider/error",
    "provider/unhandled",
    "provider/warning",
    "system/manager/user_message",
    "system/operation",
    "system/permissionGrant/lifecycle",
    "system/userQuestion/lifecycle",
    "system/thread/interrupted",
    "system/thread-provisioning",
    "thread/compacted",
    "turn/completed",
    "turn/input/accepted",
    "turn/started",
  ],
  itemEventTypes: ["item/completed", "item/started"],
  itemKinds: ["contextCompaction"],
} as const satisfies ThreadTimelineEventSelection;

interface ThreadTimelineFromEventsBaseOptions {
  includeDebugRawEvents: boolean;
  includeProviderUnhandledOperations: boolean;
  /**
   * Tail-only state (`pendingTodos`) is only meaningful on the latest page —
   * the snapshot describes current head state, not historical state. Caller
   * passes false on older-page requests so the projection can skip the
   * extraction work entirely instead of computing it and discarding.
   */
  isLatestPage: boolean;
  systemClientRequestVisibility: SystemClientRequestVisibility;
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
  pendingTodos: ThreadTimelinePendingTodos | null;
  rows: TimelineRow[];
}

export interface ThreadTimelineSourceSeqRange {
  sourceSeqEnd: number;
  sourceSeqStart: number;
}

export interface BuildThreadTimelineTurnDetailsFromEventsOptions extends ThreadTimelineSourceSeqRange {
  includeProviderUnhandledOperations: boolean;
  systemClientRequestVisibility: SystemClientRequestVisibility;
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

interface BuildTurnRowsArgs {
  includeNestedRows: boolean;
  rowIdPrefix: string;
  turn: EventProjectionTurn;
}

interface TimelineMessageBounds {
  createdAt: number;
  sourceSeqEnd: number;
  sourceSeqStart: number;
  startedAt: number;
}

interface BuildTurnSummaryRowArgs {
  completedAt: number | null;
  includeNestedRows: boolean;
  rowIdPrefix: string;
  segmentIndex: number | null;
  sourceMessages: EventProjectionMessage[];
  sourceRows: TimelineRow[];
  startedAt: number;
  summaryCount: number;
  turn: EventProjectionTurn;
}

interface BuildCompletedTurnSummaryRowsArgs {
  includeNestedRows: boolean;
  rowIdPrefix: string;
  summaryItems: CompletedTurnSummaryItem[];
  turn: EventProjectionTurn;
}

interface BuildTimelineRowsOptions {
  includeNestedRows: boolean;
  rowIdPrefix: string;
}

interface BuildGenericOperationSystemRowArgs {
  base: TimelineRowBase;
  message: TimelineOperationMessage;
  operationKind: TimelineGenericSystemOperationKind;
}

interface BuildManagerAssignmentSystemRowArgs {
  base: TimelineRowBase;
  managerAssignment: TimelineManagerAssignment;
  message: TimelineOperationMessage;
}

const ROOT_TIMELINE_ROW_ID_PREFIX = "";

type TimelineOperationMessage = Extract<
  EventProjectionMessage,
  { kind: "operation" }
>;
type TimelineGenericSystemOperationKind = Exclude<
  TimelineSystemOperationKind,
  "manager-assignment"
>;

function operationKindForMessage(
  message: TimelineOperationMessage,
  managerAssignment: TimelineManagerAssignment | null,
): TimelineSystemOperationKind {
  switch (message.opType) {
    case "compaction":
    case "thread-provisioning":
    case "thread-interrupted":
    case "provider-unhandled":
    case "warning":
    case "deprecation":
      return message.opType;
    case "operation":
      return managerAssignment !== null ? "manager-assignment" : "generic";
    default:
      return assertNever(message.opType);
  }
}

function managerAssignmentForMessage(
  message: TimelineOperationMessage,
): TimelineManagerAssignment | null {
  if (
    message.opType !== "operation" ||
    message.threadOperation?.operation !== "ownership_change"
  ) {
    return null;
  }

  const metadata = message.threadOperation.metadata;
  if (metadata === null) {
    return null;
  }
  const action = metadata.action;
  switch (action) {
    case "assign":
    case "release":
    case "transfer":
      return {
        action,
        previousManagerThreadId: metadata.previousParentThreadId,
        previousManagerThreadTitle: metadata.previousParentThreadTitle,
        nextManagerThreadId: metadata.nextParentThreadId,
        nextManagerThreadTitle: metadata.nextParentThreadTitle,
      };
    default:
      return assertNever(action);
  }
}

function buildGenericOperationSystemRow({
  base,
  message,
  operationKind,
}: BuildGenericOperationSystemRowArgs): TimelineSystemRow {
  return {
    ...base,
    kind: "system",
    systemKind: "operation",
    operationKind,
    title: message.title,
    detail: buildTimelineOperationDetail(message),
    status: message.status ?? null,
    completedAt: message.completedAt,
  };
}

function buildManagerAssignmentSystemRow({
  base,
  managerAssignment,
  message,
}: BuildManagerAssignmentSystemRowArgs): TimelineSystemRow {
  if (message.status === undefined) {
    throw new Error("Manager assignment operation message requires a status");
  }
  const status: TimelineRowStatus = message.status;
  return {
    ...base,
    kind: "system",
    systemKind: "operation",
    operationKind: "manager-assignment",
    managerAssignment,
    title: message.title,
    detail: buildTimelineOperationDetail(message),
    status,
    completedAt: message.completedAt,
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
          userRequest: message.request,
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
          userRequest: null,
        },
      ];
    case "command":
      return [
        {
          ...buildTimelineRowBase(message, options.rowIdPrefix),
          kind: "work",
          workKind: "command",
          status: message.status,
          callId: message.callId,
          command: message.command,
          cwd: message.cwd,
          source: message.source,
          output: message.output,
          exitCode: message.exitCode,
          completedAt: message.completedAt,
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
          status: message.status,
          callId: message.callId,
          toolName: message.toolName,
          toolArgs: message.toolArgs,
          output: message.output,
          completedAt: message.completedAt,
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
            status: message.status,
            interactionId: message.callId,
            approvalKind: "file-edit",
            lifecycle:
              message.approvalStatus === "denied" ? "denied" : "waiting",
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
          status: message.status,
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
          status: message.status,
          callId: message.callId,
          queries: message.queries,
          completedAt: message.completedAt,
        },
      ];
    case "web-fetch":
      return [
        {
          ...buildTimelineRowBase(message, options.rowIdPrefix),
          kind: "work",
          workKind: "web-fetch",
          status: message.status,
          callId: message.callId,
          url: message.url,
          prompt: message.prompt,
          pattern: message.pattern,
          completedAt: message.completedAt,
        },
      ];
    case "delegation": {
      const base = buildTimelineRowBase(message, options.rowIdPrefix);
      return [
        {
          ...base,
          kind: "work",
          workKind: "delegation",
          status: message.status,
          callId: message.callId,
          toolName: message.toolName,
          subagentType: message.subagentType ?? null,
          description: message.description ?? null,
          output: message.output,
          completedAt: message.completedAt,
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
          status: message.status,
          interactionId: message.interactionId,
          approvalKind: "permission-grant",
          lifecycle: message.lifecycle,
          grantScope: message.grantScope,
          statusReason: message.statusReason,
          target: message.approvalTarget,
        },
      ];
    case "user-question-lifecycle":
      return [
        {
          ...buildTimelineRowBase(message, options.rowIdPrefix),
          kind: "work",
          workKind: "question",
          status: message.status,
          interactionId: message.interactionId,
          lifecycle: message.lifecycle,
          questions: message.questions,
          answers: message.answers,
          statusReason: message.statusReason,
        },
      ];
    case "operation": {
      const managerAssignment = managerAssignmentForMessage(message);
      const operationKind = operationKindForMessage(message, managerAssignment);
      const base = buildTimelineRowBase(message, options.rowIdPrefix);
      if (operationKind === "manager-assignment") {
        return managerAssignment !== null
          ? [
              buildManagerAssignmentSystemRow({
                base,
                managerAssignment,
                message,
              }),
            ]
          : [
              buildGenericOperationSystemRow({
                base,
                message,
                operationKind: "generic",
              }),
            ];
      }
      return [
        buildGenericOperationSystemRow({
          base,
          message,
          operationKind,
        }),
      ];
    }
    case "error":
      return [
        {
          ...buildTimelineRowBase(message, options.rowIdPrefix),
          kind: "system",
          systemKind: message.reconnectAttempt ? "reconnect" : "error",
          title: message.message,
          detail: message.detail,
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

function convertPendingSteerMessage(
  message: EventProjectionMessage,
  rowIdPrefix: string,
): TimelineUserConversationRow {
  if (message.kind !== "user" || message.request.kind !== "steer") {
    throw new Error(`Expected pending steer message, received ${message.kind}`);
  }
  return {
    ...buildTimelineRowBase(message, rowIdPrefix),
    kind: "conversation",
    role: "user",
    text: message.text,
    attachments: toConversationAttachments(message.attachments),
    userRequest: message.request,
  };
}

function buildPendingSteerRowsFromEvents(
  events: ThreadEventWithMeta[],
  options: ThreadTimelineFromEventsBaseOptions,
): TimelineUserConversationRow[] {
  const orderedEvents = getOrderedThreadEvents(events);
  const acceptedClientRequestById =
    buildAcceptedClientRequestById(orderedEvents);
  const pendingSteerRows: TimelineUserConversationRow[] = [];

  for (const { event, meta } of orderedEvents) {
    const pendingSteer = parsePendingSteerFromClientRequest({
      acceptedClientRequest:
        event.type === "client/turn/requested"
          ? acceptedClientRequestById.get(event.requestId)
          : undefined,
      decoded: event,
      meta,
      options,
    });
    if (!pendingSteer) {
      continue;
    }
    pendingSteerRows.push(
      convertPendingSteerMessage(pendingSteer, ROOT_TIMELINE_ROW_ID_PREFIX),
    );
  }

  return pendingSteerRows;
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
      // Reconnect attempts are one transient status, so update the progress row
      // in place instead of flooding the timeline with every retry attempt.
      target[target.length - 1] = row;
      continue;
    }
    target.push(row);
  }
}

function getTimelineMessageBounds(
  messages: readonly EventProjectionMessage[],
): TimelineMessageBounds {
  const firstMessage = messages[0];
  if (!firstMessage) {
    throw new Error("Cannot build timeline bounds from an empty message list");
  }

  let sourceSeqStart = firstMessage.sourceSeqStart;
  let sourceSeqEnd = firstMessage.sourceSeqEnd;
  let startedAt = getMessageStartedAt(firstMessage);
  let createdAt = firstMessage.createdAt;

  for (const message of messages.slice(1)) {
    sourceSeqStart = Math.min(sourceSeqStart, message.sourceSeqStart);
    sourceSeqEnd = Math.max(sourceSeqEnd, message.sourceSeqEnd);
    startedAt = Math.min(startedAt, getMessageStartedAt(message));
    createdAt = Math.min(createdAt, message.createdAt);
  }

  return {
    createdAt,
    sourceSeqEnd,
    sourceSeqStart,
    startedAt,
  };
}

function getTimelineMessageCompletedAt(
  messages: readonly EventProjectionMessage[],
): number | null {
  if (messages.length === 0) {
    return null;
  }
  let completedAt = messages[0].createdAt;
  for (const message of messages.slice(1)) {
    completedAt = Math.max(completedAt, message.createdAt);
  }
  return completedAt;
}

function getTurnBounds(turn: EventProjectionTurn): TimelineMessageBounds {
  return {
    createdAt: turn.createdAt,
    sourceSeqEnd: turn.sourceSeqEnd,
    sourceSeqStart: turn.sourceSeqStart,
    startedAt: turn.startedAt,
  };
}

function buildTurnSummaryRow({
  completedAt,
  includeNestedRows,
  rowIdPrefix,
  segmentIndex,
  sourceMessages,
  sourceRows,
  startedAt,
  summaryCount,
  turn,
}: BuildTurnSummaryRowArgs): TimelineTurnRow | null {
  if (summaryCount === 0 && sourceRows.length === 0) {
    return null;
  }

  const bounds =
    segmentIndex === null || sourceMessages.length === 0
      ? getTurnBounds(turn)
      : getTimelineMessageBounds(sourceMessages);
  const rowId =
    segmentIndex === null
      ? `${rowIdPrefix}${turn.threadId}:${turn.turnId}:turn`
      : `${rowIdPrefix}${turn.threadId}:${turn.turnId}:turn:${segmentIndex}`;
  const resolvedCompletedAt =
    completedAt ?? getTimelineMessageCompletedAt(sourceMessages);

  return {
    id: rowId,
    threadId: turn.threadId,
    turnId: turn.turnId,
    sourceSeqStart: bounds.sourceSeqStart,
    sourceSeqEnd: bounds.sourceSeqEnd,
    startedAt,
    createdAt: bounds.createdAt,
    kind: "turn",
    status: turn.status,
    summaryCount,
    completedAt: resolvedCompletedAt,
    children: includeNestedRows ? sourceRows : null,
  };
}

function buildCompletedTurnSummaryRows({
  includeNestedRows,
  rowIdPrefix,
  summaryItems,
  turn,
}: BuildCompletedTurnSummaryRowsArgs): TimelineRow[] {
  const rows: TimelineRow[] = [];
  for (const item of summaryItems) {
    if (item.kind === "ungrouped-message") {
      rows.push(
        ...convertMessage(item.message, {
          includeNestedRows,
          rowIdPrefix,
        }),
      );
      continue;
    }

    const sourceRows = includeNestedRows
      ? item.sourceMessages.flatMap((message) =>
          convertMessage(message, { includeNestedRows, rowIdPrefix }),
        )
      : [];
    const turnRow = buildTurnSummaryRow({
      completedAt: item.completedAt,
      includeNestedRows,
      rowIdPrefix,
      segmentIndex: item.segmentIndex,
      sourceMessages: item.sourceMessages,
      sourceRows,
      startedAt: item.startedAt,
      summaryCount: item.summaryCount,
      turn,
    });
    if (turnRow) {
      rows.push(turnRow);
    }
  }
  return rows;
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

  const { summaryItems, terminalMessages, trailingMessages } =
    groupCompletedTurnMessages(turn);
  const terminalRows = terminalMessages.flatMap((message) =>
    convertMessage(message, { includeNestedRows, rowIdPrefix }),
  );
  const trailingRows = trailingMessages.flatMap((message) =>
    convertMessage(message, { includeNestedRows, rowIdPrefix }),
  );
  const summaryRows = buildCompletedTurnSummaryRows({
    includeNestedRows,
    rowIdPrefix,
    summaryItems,
    turn,
  });
  return [...summaryRows, ...terminalRows, ...trailingRows];
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
    includeProviderUnhandledOperations:
      args.options.includeProviderUnhandledOperations,
    systemClientRequestVisibility: args.options.systemClientRequestVisibility,
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

  const rows =
    args.options.viewMode === "manager-conversation"
      ? buildManagerConversationRows(projection)
      : [
          ...buildTimelineRows(projection, {
            includeNestedRows: args.options.includeNestedRows,
            rowIdPrefix: ROOT_TIMELINE_ROW_ID_PREFIX,
          }),
          ...buildPendingSteerRowsFromEvents(args.events, args.options),
        ];

  return {
    activeThinking:
      args.options.viewMode === "manager-conversation"
        ? null
        : projection.state.activeThinking,
    contextWindowUsage: extractThreadContextWindowUsage(
      args.contextWindowEvents,
    ),
    pendingTodos:
      args.options.viewMode === "manager-conversation" ||
      !args.options.isLatestPage
        ? null
        : extractThreadTimelinePendingTodos(
            args.options.threadStatus,
            args.events,
          ),
    rows,
  };
}

export function buildThreadTimelineTurnDetailsFromEvents(
  args: BuildThreadTimelineTurnDetailsFromEventsArgs,
): ThreadTimelineTurnDetailsFromEventsResult {
  const projection = buildEventProjectionEntries(args.events, {
    includeDebugRawEvents: false,
    includeProviderUnhandledOperations:
      args.options.includeProviderUnhandledOperations,
    systemClientRequestVisibility: args.options.systemClientRequestVisibility,
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
