import type {
  ThreadContextWindowUsage,
  TimelineActivityIntent,
  TimelineConversationAttachments,
  TimelineFileChange,
  TimelineParentChange,
  TimelineRow,
  TimelineRowBase,
  TimelineRowStatus,
  TimelineSourceRow,
  TimelineSystemOperationKind,
  TimelineSystemRow,
  TimelineTurnRow,
  TimelineUserConversationRow,
  TimelineWorkflowWorkRow,
} from "@bb/server-contract";
import {
  isBackgroundAgentTaskType,
  readTerminalOutputLines,
  type ActiveThinking,
  type Thread,
  type ThreadEventItemPresentation,
  type ThreadTimelineActivePromptMode,
  type ThreadTimelineGoal,
  type ThreadTimelineModelFallback,
  type ThreadTimelinePendingTodos,
} from "@bb/domain";
import type {
  EventProjectionErrorMessage,
  EventProjectionFileEditChange,
  EventProjectionMessage,
  EventProjection,
  EventProjectionProvisioningTranscriptEntry,
  EventProjectionToolParsedIntent,
  EventProjectionTurn,
} from "./event-projection-types.js";
import { assertNever } from "./assert-never.js";
import {
  durationToCompactString,
  getMessageStartedAt,
} from "./format-helpers.js";
import { getFileChangeDiffStats } from "./file-change-summary.js";
import { getEventProjectionMessageScopeTurnId } from "./message-scope.js";
import {
  buildEventProjection,
  buildEventProjectionEntries,
  type ThreadEventWithMeta,
} from "./build-event-projection.js";
import {
  buildAcceptedClientRequestById,
  buildRejectedClientRequestById,
  type AcceptedClientRequestContext,
} from "./accepted-client-request-context.js";
import {
  parsePendingSteersFromClientRequest,
  parseRejectedUsersFromClientRequest,
} from "./user-message-parsing.js";
import { getOrderedThreadEvents } from "./group-event-projection-turns.js";
import {
  groupCompletedTurnMessages,
  type CompletedTurnSummaryItem,
} from "./completed-turn-grouping.js";
import { extractThreadContextWindowUsage } from "./thread-context-window-usage.js";
import {
  extractThreadTimelineActivePromptMode,
  type PlanCommand,
} from "./active-prompt-mode-extraction.js";
import { extractThreadTimelineGoal } from "./goal-snapshot-extraction.js";
import { extractThreadTimelineModelFallback } from "./model-fallback-extraction.js";
import { extractThreadTimelinePendingTodos } from "./todo-snapshot-extraction.js";
import { buildTimelineErrorDisplay } from "./error-display.js";

type ThreadTimelineTurnMessageDetail = "summary" | "full";

interface ThreadTimelineFromEventsBaseOptions {
  contextOnlyToolCallIds?: ReadonlySet<string>;
  includeProviderUnhandledOperations: boolean;
  isLatestPage: boolean;
  providerId?: string;
  providerDisplayName?: string;
  planCommand?: PlanCommand | null;
  threadStatus: Thread["status"];
  threadName: string;
  workspaceRoot: string | null;
}

interface ThreadTimelineFromEventsOptions extends ThreadTimelineFromEventsBaseOptions {
  includeNestedRows: boolean;
  turnMessageDetail: ThreadTimelineTurnMessageDetail;
}

interface BuildThreadTimelineFromEventsArgs {
  acceptedClientRequestContext: AcceptedClientRequestContext;
  contextWindowEvents: ThreadEventWithMeta[];
  events: ThreadEventWithMeta[];
  options: ThreadTimelineFromEventsOptions;
}

export interface ThreadTimelineFromEventsResult {
  activePromptMode: ThreadTimelineActivePromptMode | null;
  activeThinking: ActiveThinking | null;
  activeWorkflows: TimelineWorkflowWorkRow[];
  activeBackgroundCommands: TimelineWorkflowWorkRow[];
  contextWindowUsage: ThreadContextWindowUsage | null;
  goal: ThreadTimelineGoal | null;
  modelFallback: ThreadTimelineModelFallback | null;
  pendingTodos: ThreadTimelinePendingTodos | null;
  rows: TimelineRow[];
}

interface ThreadTimelineSourceSeqRange {
  sourceSeqEnd: number;
  sourceSeqStart: number;
}

interface BuildThreadTimelineTurnDetailsFromEventsOptions extends ThreadTimelineSourceSeqRange {
  includeProviderUnhandledOperations: boolean;
  providerDisplayName?: string;
  threadStatus: Thread["status"];
  threadName: string;
  workspaceRoot: string | null;
}

interface BuildThreadTimelineTurnDetailsFromEventsArgs {
  events: ThreadEventWithMeta[];
  options: BuildThreadTimelineTurnDetailsFromEventsOptions;
}

type ThreadTimelineTurnDetailsFromEventsResult =
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
  workspaceRoot: string | null;
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
  workspaceRoot: string | null;
}

interface BuildTimelineRowsOptions {
  includeNestedRows: boolean;
  rowIdPrefix: string;
  workspaceRoot: string | null;
}

interface BuildGenericOperationSystemRowArgs {
  base: TimelineRowBase;
  message: TimelineOperationMessage;
  operationKind: TimelineGenericSystemOperationKind;
}

interface BuildParentChangeSystemRowArgs {
  base: TimelineRowBase;
  parentChange: TimelineParentChange;
  message: TimelineOperationMessage;
}

const ROOT_TIMELINE_ROW_ID_PREFIX = "";

type TimelineOperationMessage = Extract<
  EventProjectionMessage,
  { kind: "operation" }
>;
type TimelineWorkflowMessage = Extract<
  EventProjectionMessage,
  { kind: "workflow" }
>;
/** Every kind that renders as the plain title/detail row — i.e. the ones that
 * do not carry their own extra fields in the read model. */
type TimelineGenericSystemOperationKind = Exclude<
  TimelineSystemOperationKind,
  "parent-change"
>;

function operationKindForMessage(
  message: TimelineOperationMessage,
  parentChange: TimelineParentChange | null,
): TimelineSystemOperationKind {
  switch (message.opType) {
    case "compaction":
    case "context-clear":
    case "thread-provisioning":
    case "thread-interrupted":
    case "provider-unhandled":
    case "warning":
    case "deprecation":
      return message.opType;
    case "provider-environment":
      return "generic";
    case "operation":
      return parentChange !== null ? "parent-change" : "generic";
    default:
      return assertNever(message.opType);
  }
}

function parentChangeForMessage(
  message: TimelineOperationMessage,
): TimelineParentChange | null {
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
        previousParentThreadId: metadata.previousParentThreadId,
        previousParentThreadTitle: metadata.previousParentThreadTitle,
        nextParentThreadId: metadata.nextParentThreadId,
        nextParentThreadTitle: metadata.nextParentThreadTitle,
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

function buildParentChangeSystemRow({
  base,
  parentChange,
  message,
}: BuildParentChangeSystemRowArgs): TimelineSystemRow {
  if (message.status === undefined) {
    throw new Error("Parent change operation message requires a status");
  }
  const status: TimelineRowStatus = message.status;
  return {
    ...base,
    kind: "system",
    systemKind: "operation",
    operationKind: "parent-change",
    parentChange,
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

function buildWorkflowWorkRow(
  message: TimelineWorkflowMessage,
  rowIdPrefix: string,
): TimelineWorkflowWorkRow | null {
  if (message.skipTranscript) {
    return null;
  }
  return {
    ...buildTimelineRowBase(message, rowIdPrefix),
    kind: "work",
    workKind: "workflow",
    status: message.status,
    itemId: message.itemId,
    taskType: message.taskType,
    workflowName: message.workflowName,
    description: message.description,
    model: message.model,
    taskStatus: message.taskStatus,
    workflow: message.workflow,
    usage: message.usage,
    summary: message.summary,
    error: message.error,
    completedAt: message.completedAt,
    ...rowPresentation(message),
  };
}

function isDelegationLifecycleChildRow(row: TimelineRow): boolean {
  return (
    row.kind === "work" &&
    row.workKind === "workflow" &&
    isBackgroundAgentTaskType(row.taskType)
  );
}

function filterDelegationChildRows(childRows: TimelineRow[]): TimelineRow[] {
  return childRows.filter((row) => !isDelegationLifecycleChildRow(row));
}

function isReconnectErrorMessage(
  message: EventProjectionErrorMessage,
): boolean {
  return message.reconnectAttempt !== undefined || message.willRetry === true;
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

function rowPresentation(message: {
  presentation?: ThreadEventItemPresentation;
}): { presentation?: ThreadEventItemPresentation } {
  return message.presentation ? { presentation: message.presentation } : {};
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

function relativizeWorkspacePath(
  path: string,
  workspaceRoot: string | null,
): string {
  if (!workspaceRoot) return path;
  const normalizedRoot = workspaceRoot.replace(/\/+$/u, "");
  if (normalizedRoot.length === 0) return path;
  if (path.startsWith(`${normalizedRoot}/`)) {
    return path.slice(normalizedRoot.length + 1);
  }
  return path;
}

function toTimelineFileChange(
  change: EventProjectionFileEditChange,
  workspaceRoot: string | null,
): TimelineFileChange {
  return {
    path: relativizeWorkspacePath(change.path, workspaceRoot),
    kind: change.kind ?? null,
    movePath:
      change.movePath == null
        ? null
        : relativizeWorkspacePath(change.movePath, workspaceRoot),
    diff: change.diff ?? null,
    diffStats: getFileChangeDiffStats(change),
  };
}

function formatProvisioningTranscriptEntryText(
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

function formatProvisioningTranscriptEntryLines(
  entry: EventProjectionProvisioningTranscriptEntry,
): string[] {
  return readTerminalOutputLines(formatProvisioningTranscriptEntryText(entry));
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
    message.provisioning?.transcript?.flatMap(
      formatProvisioningTranscriptEntryLines,
    ) ?? [];
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
          mentions: message.mentions,
          attachments: toConversationAttachments(message.attachments),
          initiator: message.initiator,
          senderThreadId: message.senderThreadId,
          systemMessageKind: message.systemMessageKind,
          systemMessageSubject: message.systemMessageSubject,
          turnRequest: message.turnRequest,
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
          turnRequest: null,
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
          ...rowPresentation(message),
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
          ...rowPresentation(message),
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
          change: toTimelineFileChange(change, options.workspaceRoot),
          stdout: message.stdout ?? null,
          stderr: message.stderr ?? null,
          approvalStatus: message.approvalStatus,
          ...rowPresentation(message),
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
          ...rowPresentation(message),
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
          ...rowPresentation(message),
        },
      ];
    case "image-view":
      return [
        {
          ...buildTimelineRowBase(message, options.rowIdPrefix),
          kind: "work",
          workKind: "image-view",
          status: message.status,
          callId: message.callId,
          path: message.path,
          completedAt: message.completedAt,
          ...rowPresentation(message),
        },
      ];
    case "file-read":
      return [
        {
          ...buildTimelineRowBase(message, options.rowIdPrefix),
          kind: "work",
          workKind: "file-read",
          status: message.status,
          callId: message.callId,
          path: message.path,
          cmd: message.cmd,
          completedAt: message.completedAt,
          ...rowPresentation(message),
        },
      ];
    case "search":
      return [
        {
          ...buildTimelineRowBase(message, options.rowIdPrefix),
          kind: "work",
          workKind: "search",
          status: message.status,
          callId: message.callId,
          mode: message.mode,
          query: message.query,
          path: message.path,
          cmd: message.cmd,
          completedAt: message.completedAt,
          ...rowPresentation(message),
        },
      ];
    case "plan-steps":
      return [
        {
          ...buildTimelineRowBase(message, options.rowIdPrefix),
          kind: "work",
          workKind: "plan-steps",
          status: message.status,
          callId: message.callId,
          steps: message.steps,
          explanation: message.explanation,
          completedAt: message.completedAt,
          ...rowPresentation(message),
        },
      ];
    case "extension":
      return [
        {
          ...buildTimelineRowBase(message, options.rowIdPrefix),
          kind: "work",
          workKind: "extension",
          status: message.status,
          callId: message.callId,
          extensionKind: message.extensionKind,
          payload: message.payload,
          completedAt: message.completedAt,
          presentation: message.presentation,
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
          childRef: message.childRef,
          background: message.background,
          subagentType: message.subagentType ?? null,
          description: message.description ?? null,
          output: message.output,
          completedAt: message.completedAt,
          childRows: filterDelegationChildRows(
            buildTimelineRows(message.childProjection, {
              includeNestedRows: true,
              rowIdPrefix: `${base.id}:child:`,
              workspaceRoot: options.workspaceRoot,
            }),
          ),
          ...rowPresentation(message),
        },
      ];
    }
    case "workflow": {
      const row = buildWorkflowWorkRow(message, options.rowIdPrefix);
      return row ? [row] : [];
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
      const parentChange = parentChangeForMessage(message);
      const operationKind = operationKindForMessage(message, parentChange);
      const base = buildTimelineRowBase(message, options.rowIdPrefix);
      if (operationKind === "parent-change") {
        return parentChange !== null
          ? [
              buildParentChangeSystemRow({
                base,
                parentChange,
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
    case "error": {
      const errorDisplay = buildTimelineErrorDisplay(message);
      const isReconnect = isReconnectErrorMessage(message);
      return [
        {
          ...buildTimelineRowBase(message, options.rowIdPrefix),
          kind: "system",
          systemKind: isReconnect ? "reconnect" : "error",
          title: errorDisplay.title,
          detail: errorDisplay.detail,
          status: isReconnect ? null : "error",
        },
      ];
    }
    default:
      return assertNever(message);
  }
}

function convertSteerMessage(
  message: EventProjectionMessage,
  rowIdPrefix: string,
): TimelineUserConversationRow {
  if (message.kind !== "user" || message.turnRequest.kind !== "steer") {
    throw new Error(`Expected steer message, received ${message.kind}`);
  }
  return {
    ...buildTimelineRowBase(message, rowIdPrefix),
    kind: "conversation",
    role: "user",
    text: message.text,
    mentions: message.mentions,
    attachments: toConversationAttachments(message.attachments),
    initiator: message.initiator,
    senderThreadId: message.senderThreadId,
    systemMessageKind: message.systemMessageKind,
    systemMessageSubject: message.systemMessageSubject,
    turnRequest: message.turnRequest,
  };
}

function buildPendingSteerRowsFromEvents(
  acceptedClientRequestContext: AcceptedClientRequestContext,
  events: ThreadEventWithMeta[],
  options: ThreadTimelineFromEventsBaseOptions,
): TimelineUserConversationRow[] {
  const orderedEvents = getOrderedThreadEvents(events);
  const acceptedClientRequestById = buildAcceptedClientRequestById({
    context: acceptedClientRequestContext,
    events: orderedEvents,
  });
  const rejectedClientRequestById = buildRejectedClientRequestById(
    acceptedClientRequestContext,
    orderedEvents,
  );
  const inWindowRejectedClientRequestIds = new Set(
    orderedEvents.flatMap(({ event }) =>
      event.type === "client/turn/rejected" ? [event.requestId] : [],
    ),
  );
  const legacyRejectedRequestMetaById = new Map<
    string,
    ThreadEventWithMeta["meta"]
  >();
  const unresolvedSteerRequestIds = new Set<string>();
  const unresolvedSteerRequestOrder: string[] = [];
  let explicitRejectionNeedsCompanionError = false;
  for (const { event, meta } of orderedEvents) {
    if (
      event.type === "client/turn/requested" &&
      (event.target.kind === "auto" || event.target.kind === "steer") &&
      event.target.expectedTurnId !== null
    ) {
      unresolvedSteerRequestIds.add(event.requestId);
      unresolvedSteerRequestOrder.push(event.requestId);
      explicitRejectionNeedsCompanionError = false;
      continue;
    }
    if (event.type === "turn/input/accepted") {
      unresolvedSteerRequestIds.delete(event.clientRequestId);
      explicitRejectionNeedsCompanionError = false;
      continue;
    }
    if (event.type === "client/turn/rejected") {
      unresolvedSteerRequestIds.delete(event.requestId);
      explicitRejectionNeedsCompanionError = true;
      continue;
    }
    if (
      event.type === "system/error" &&
      event.code === "thread_command_failed"
    ) {
      if (explicitRejectionNeedsCompanionError) {
        explicitRejectionNeedsCompanionError = false;
        continue;
      }
      let requestId = unresolvedSteerRequestOrder.pop();
      while (requestId && !unresolvedSteerRequestIds.delete(requestId)) {
        requestId = unresolvedSteerRequestOrder.pop();
      }
      if (requestId) legacyRejectedRequestMetaById.set(requestId, meta);
      continue;
    }
    explicitRejectionNeedsCompanionError = false;
  }
  const pendingSteerRows: TimelineUserConversationRow[] = [];

  for (const { event, meta } of orderedEvents) {
    if (
      event.type === "client/turn/requested" &&
      inWindowRejectedClientRequestIds.has(event.requestId)
    ) {
      continue;
    }
    const acceptedClientRequest =
      event.type === "client/turn/requested"
        ? acceptedClientRequestById.get(event.requestId)
        : undefined;
    const legacyRejectedMeta =
      event.type === "client/turn/requested"
        ? legacyRejectedRequestMetaById.get(event.requestId)
        : undefined;
    const rejectedMeta =
      event.type === "client/turn/requested"
        ? rejectedClientRequestById.get(event.requestId)
        : undefined;
    if (
      event.type === "client/turn/requested" &&
      acceptedClientRequest === undefined &&
      rejectedMeta
    ) {
      pendingSteerRows.push(
        ...parseRejectedUsersFromClientRequest({
          decoded: event,
          meta: rejectedMeta,
          options,
        }).map((rejectedSteer) =>
          convertSteerMessage(rejectedSteer, ROOT_TIMELINE_ROW_ID_PREFIX),
        ),
      );
      continue;
    }
    if (
      event.type === "client/turn/requested" &&
      acceptedClientRequest === undefined &&
      legacyRejectedMeta
    ) {
      pendingSteerRows.push(
        ...parseRejectedUsersFromClientRequest({
          decoded: event,
          meta: legacyRejectedMeta,
          options,
        }).map((rejectedSteer) =>
          convertSteerMessage(rejectedSteer, ROOT_TIMELINE_ROW_ID_PREFIX),
        ),
      );
      continue;
    }
    const pendingSteers = parsePendingSteersFromClientRequest({
      acceptedClientRequest,
      decoded: event,
      meta,
      options,
    });
    if (pendingSteers.length === 0) {
      continue;
    }
    pendingSteerRows.push(
      ...pendingSteers.map((pendingSteer) =>
        convertSteerMessage(pendingSteer, ROOT_TIMELINE_ROW_ID_PREFIX),
      ),
    );
  }

  return pendingSteerRows;
}

function isReconnectSystemRow(row: TimelineRow): boolean {
  return row.kind === "system" && row.systemKind === "reconnect";
}

function isErrorSystemRow(row: TimelineRow): boolean {
  return row.kind === "system" && row.systemKind === "error";
}

function isThreadInterruptedOperationRow(row: TimelineRow): boolean {
  return (
    row.kind === "system" &&
    row.systemKind === "operation" &&
    row.operationKind === "thread-interrupted"
  );
}

function isCompanionThreadInterruptedRow(
  previous: TimelineRow,
  row: TimelineRow,
): boolean {
  return (
    isErrorSystemRow(previous) &&
    isThreadInterruptedOperationRow(row) &&
    previous.threadId === row.threadId &&
    previous.createdAt === row.createdAt &&
    previous.startedAt === row.startedAt &&
    previous.sourceSeqEnd + 1 === row.sourceSeqStart
  );
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
    if (previous && isCompanionThreadInterruptedRow(previous, row)) {
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
  workspaceRoot,
}: BuildCompletedTurnSummaryRowsArgs): TimelineRow[] {
  const rows: TimelineRow[] = [];
  for (const item of summaryItems) {
    if (item.kind === "ungrouped-message") {
      rows.push(
        ...convertMessage(item.message, {
          includeNestedRows,
          rowIdPrefix,
          workspaceRoot,
        }),
      );
      continue;
    }

    const sourceRows = includeNestedRows
      ? item.sourceMessages.flatMap((message) =>
          convertMessage(message, {
            includeNestedRows,
            rowIdPrefix,
            workspaceRoot,
          }),
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
  workspaceRoot,
}: BuildTurnRowsArgs): TimelineRow[] {
  const messages = turn.messages ?? [];
  const isCompletedTurn =
    turn.status !== "pending" && turn.completedAt !== null;

  if (!isCompletedTurn) {
    return messages.flatMap((message) =>
      convertMessage(message, {
        includeNestedRows,
        rowIdPrefix,
        workspaceRoot,
      }),
    );
  }

  const { summaryItems, terminalMessages, trailingMessages } =
    groupCompletedTurnMessages(turn);
  const terminalRows = terminalMessages.flatMap((message) =>
    convertMessage(message, { includeNestedRows, rowIdPrefix, workspaceRoot }),
  );
  const trailingRows = trailingMessages.flatMap((message) =>
    convertMessage(message, { includeNestedRows, rowIdPrefix, workspaceRoot }),
  );
  const summaryRows = buildCompletedTurnSummaryRows({
    includeNestedRows,
    rowIdPrefix,
    summaryItems,
    turn,
    workspaceRoot,
  });
  return [...summaryRows, ...terminalRows, ...trailingRows];
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

function isRootOwnedHumanSteerRow(row: TimelineRow): boolean {
  return (
    row.kind === "conversation" &&
    row.role === "user" &&
    row.initiator === "user" &&
    row.turnRequest?.kind === "steer"
  );
}

function collectExternalUserBoundarySeqs(
  projection: EventProjection,
): number[] {
  const boundarySeqs = new Set<number>();
  for (const entry of projection.entries) {
    if (entry.kind !== "turn") {
      continue;
    }
    for (const seq of entry.turn.externalUserBoundarySeqs ?? []) {
      boundarySeqs.add(seq);
    }
  }
  return [...boundarySeqs].sort((left, right) => left - right);
}

function compareTimelineRowsBySource(
  left: TimelineRow,
  right: TimelineRow,
): number {
  if (left.sourceSeqStart !== right.sourceSeqStart) {
    return left.sourceSeqStart - right.sourceSeqStart;
  }
  if (left.sourceSeqEnd !== right.sourceSeqEnd) {
    return left.sourceSeqEnd - right.sourceSeqEnd;
  }
  return 0;
}

function orderRowsAfterExternalUserBoundary(
  rows: TimelineRow[],
  boundarySeqs: readonly number[],
): TimelineRow[] {
  const firstBoundarySeq = boundarySeqs[0];
  if (firstBoundarySeq === undefined) {
    return rows;
  }

  const suffixStartIndex = rows.findIndex(
    (row) => row.sourceSeqStart >= firstBoundarySeq,
  );
  if (suffixStartIndex === -1) {
    return rows;
  }

  const suffix = rows.slice(suffixStartIndex);
  const orderedSuffix = suffix
    .map((row, index) => ({ index, row }))
    .sort((left, right) => {
      const sourceOrder = compareTimelineRowsBySource(left.row, right.row);
      return sourceOrder === 0 ? left.index - right.index : sourceOrder;
    })
    .map(({ row }) => row);

  return [...rows.slice(0, suffixStartIndex), ...orderedSuffix];
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
            workspaceRoot: options.workspaceRoot,
          }),
        );
        break;
      default:
        assertNever(entry);
    }
  }

  return orderRowsAfterExternalUserBoundary(
    rows,
    collectExternalUserBoundarySeqs(projection),
  );
}

export function buildThreadTimelineFromEvents(
  args: BuildThreadTimelineFromEventsArgs,
): ThreadTimelineFromEventsResult {
  const projectionOptions = {
    acceptedClientRequestContext: args.acceptedClientRequestContext,
    includeProviderUnhandledOperations:
      args.options.includeProviderUnhandledOperations,
    contextOnlyToolCallIds: args.options.contextOnlyToolCallIds,
    providerDisplayName: args.options.providerDisplayName,
    threadStatus: args.options.threadStatus,
    threadName: args.options.threadName,
    turnMessageDetail: args.options.turnMessageDetail,
  } satisfies Parameters<typeof buildEventProjection>[1];
  const projection = buildEventProjection(args.events, projectionOptions);

  const rows = [
    ...buildTimelineRows(projection, {
      includeNestedRows: args.options.includeNestedRows,
      rowIdPrefix: ROOT_TIMELINE_ROW_ID_PREFIX,
      workspaceRoot: args.options.workspaceRoot,
    }),
    ...buildPendingSteerRowsFromEvents(
      args.acceptedClientRequestContext,
      args.events,
      args.options,
    ),
  ];

  return {
    activePromptMode: !args.options.isLatestPage
      ? null
      : extractThreadTimelineActivePromptMode({
          events: args.events,
          planCommand: args.options.planCommand,
          providerId: args.options.providerId,
          threadStatus: args.options.threadStatus,
        }),
    activeThinking: projection.state.activeThinking,
    activeWorkflows: projection.state.activeWorkflows.flatMap((message) => {
      const row = buildWorkflowWorkRow(message, ROOT_TIMELINE_ROW_ID_PREFIX);
      return row ? [row] : [];
    }),
    activeBackgroundCommands: projection.state.activeBackgroundCommands.flatMap(
      (message) => {
        const row = buildWorkflowWorkRow(message, ROOT_TIMELINE_ROW_ID_PREFIX);
        return row ? [row] : [];
      },
    ),
    contextWindowUsage: extractThreadContextWindowUsage(
      args.contextWindowEvents,
    ),
    goal: !args.options.isLatestPage
      ? null
      : extractThreadTimelineGoal(args.events),
    modelFallback: !args.options.isLatestPage
      ? null
      : extractThreadTimelineModelFallback(args.events),
    pendingTodos: !args.options.isLatestPage
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
    includeProviderUnhandledOperations:
      args.options.includeProviderUnhandledOperations,
    providerDisplayName: args.options.providerDisplayName,
    threadStatus: args.options.threadStatus,
    threadName: args.options.threadName,
    turnMessageDetail: "full",
  });
  const nestedRows = buildTimelineRows(projection, {
    includeNestedRows: true,
    rowIdPrefix: ROOT_TIMELINE_ROW_ID_PREFIX,
    workspaceRoot: args.options.workspaceRoot,
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
    rows: nestedRows.filter((row) => !isRootOwnedHumanSteerRow(row)),
  };
}
