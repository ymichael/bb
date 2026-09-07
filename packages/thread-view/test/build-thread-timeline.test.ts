import { threadScope, turnScope } from "@bb/domain";
import type {
  ApprovalPendingInteractionResolution,
  JsonObject,
  OwnershipChangeOperationAction,
  PromptInput,
  ProviderErrorInfo,
  ThreadEventBackgroundTaskItem,
  ThreadEventFileChange,
  ThreadEventItemStatus,
  UserQuestionPendingInteractionResolution,
} from "@bb/domain";
import type {
  TimelineApprovalWorkRow,
  ThreadContextWindowUsage,
  TimelineFileChangeWorkRow,
  TimelineImageViewWorkRow,
  TimelineParentChange,
  TimelineQuestionWorkRow,
  TimelineRow,
  TimelineSystemRow,
  TimelineToolWorkRow,
} from "@bb/server-contract";
import { describe, expect, it } from "vitest";
import {
  buildTimelineRowTitle,
  buildThreadTimelineFromEvents,
  extractThreadTimelineActivePlanTurn,
  type ThreadEventWithMeta,
} from "../src/index.js";
import { EMPTY_ACCEPTED_CLIENT_REQUEST_CONTEXT } from "../src/accepted-client-request-context.js";
import { parseOperationMessage } from "../src/parse-operation-message.js";
import {
  createTimelineEventFactory,
  fromRows,
} from "./timeline-test-harness.js";

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
  parentToolCallId?: string;
  statusLabels?: { pending: string; completed: string };
  itemId?: string;
  result?: string;
  seq: number;
  status?: ThreadEventItemStatus;
  tool: string;
  toolArgs?: JsonObject;
  type: "item/completed" | "item/started";
}

interface ImageViewItemEventArgs {
  itemId?: string;
  path?: string;
  seq: number;
  type: "item/completed" | "item/started";
}

interface PlanItemEventArgs {
  itemId?: string;
  seq: number;
  text: string;
}

const planPromptInput: PromptInput[] = [
  {
    type: "text",
    text: "/plan inspect the failing command",
    mentions: [
      {
        start: 0,
        end: 5,
        resource: {
          kind: "command",
          trigger: "/",
          name: "plan",
          source: "command",
          origin: "user",
          label: "plan",
          argumentHint: null,
        },
      },
    ],
  },
];

interface PlanDeltaEventArgs {
  itemId?: string;
  seq: number;
  text: string;
}

interface TurnStartedEventArgs {
  seq: number;
}

interface TurnCompletedEventArgs {
  errorMessage?: string;
  seq: number;
  status?: "completed" | "failed" | "interrupted";
}

interface SystemOperationEventArgs {
  message: string;
  metadata?: JsonObject;
  operation?: string;
  operationId?: string;
  seq: number;
  status?: "running" | "completed" | "failed" | "pending" | "resolved";
}

interface PermissionGrantLifecycleEventArgs {
  interactionId?: string;
  resolution?: ApprovalPendingInteractionResolution | null;
  seq: number;
  status?: "pending" | "resolving" | "resolved" | "interrupted";
  statusReason?: string | null;
  toolName?: string | null;
}

interface SystemErrorEventArgs {
  code?: string;
  detail?: string;
  message: string;
  seq: number;
}

interface SystemProviderTurnWatchdogEventArgs {
  activeTurnId?: string;
  activeTurnStartedAt?: number;
  elapsedMs?: number;
  firedAt?: number;
  lastActivityEventAt?: number;
  lastActivityEventSequence?: number;
  lastActivityEventType?: string;
  providerId?: string;
  providerThreadId?: string | null;
  seq: number;
  thresholdMs?: number;
}

interface ProviderErrorEventArgs {
  detail?: string;
  errorInfo?: ProviderErrorInfo;
  message?: string;
  seq: number;
  willRetry?: boolean;
}

interface UserQuestionLifecycleEventArgs {
  interactionId?: string;
  questionPrompt?: string;
  resolution?: UserQuestionPendingInteractionResolution | null;
  seq: number;
  status?: "pending" | "resolving" | "resolved" | "interrupted";
  statusReason?: string | null;
}

interface BackgroundTaskStartedEventArgs {
  description: string;
  id: string;
  parentToolCallId: string;
  seq: number;
  taskType: string;
}

type BuildTimelineRowsThreadStatus = "active" | "idle";
type TimelineConversationRow = Extract<TimelineRow, { kind: "conversation" }>;
type TimelineDelegationWorkRow = Extract<
  TimelineRow,
  { kind: "work"; workKind: "delegation" }
>;
type TimelineWorkflowRow = Extract<
  TimelineRow,
  { kind: "work"; workKind: "workflow" }
>;

interface OwnershipOperationCase {
  action: OwnershipChangeOperationAction;
  parentChangeAction: TimelineParentChange["action"];
  message: string;
  nextParentThreadId: string | null;
  nextParentThreadTitle: string | null;
  previousParentThreadId: string | null;
  previousParentThreadTitle: string | null;
}

const ownershipOperationCases: OwnershipOperationCase[] = [
  {
    action: "assign",
    parentChangeAction: "assign",
    message: "Assigned to Parent",
    nextParentThreadId: "thr-parent",
    nextParentThreadTitle: "Parent",
    previousParentThreadId: null,
    previousParentThreadTitle: null,
  },
  {
    action: "release",
    parentChangeAction: "release",
    message: "Released from Parent",
    nextParentThreadId: null,
    nextParentThreadTitle: null,
    previousParentThreadId: "thr-parent",
    previousParentThreadTitle: "Parent",
  },
  {
    action: "transfer",
    parentChangeAction: "transfer",
    message: "Transferred to Next Parent",
    nextParentThreadId: "thr-parent-next",
    nextParentThreadTitle: "Next Parent",
    previousParentThreadId: "thr-parent-previous",
    previousParentThreadTitle: "Previous Parent",
  },
];

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
  parentToolCallId,
  statusLabels,
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
        ...(parentToolCallId ? { parentToolCallId } : {}),
        ...(statusLabels ? { statusLabels } : {}),
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

function imageViewItemEvent({
  itemId = "image-view-1",
  path = "/tmp/sightglass-quote-merge-check/dashboard-main.png",
  seq,
  type,
}: ImageViewItemEventArgs): ThreadEventWithMeta {
  return {
    event: {
      type,
      threadId: "thread-1",
      providerThreadId: "provider-thread-1",
      scope: turnScope("turn-1"),
      item: {
        type: "imageView",
        id: itemId,
        path,
      },
    },
    meta: {
      id: `event-${seq}`,
      seq,
      createdAt: seq,
    },
  };
}

function planDeltaEvent({
  itemId = "plan-1",
  seq,
  text,
}: PlanDeltaEventArgs): ThreadEventWithMeta {
  return {
    event: {
      type: "item/plan/delta",
      threadId: "thread-1",
      providerThreadId: "provider-thread-1",
      scope: turnScope("turn-1"),
      itemId,
      delta: text,
    },
    meta: {
      id: `event-${seq}`,
      seq,
      createdAt: seq,
    },
  };
}

function planItemCompletedEvent({
  itemId = "plan-1",
  seq,
  text,
}: PlanItemEventArgs): ThreadEventWithMeta {
  return {
    event: {
      type: "item/completed",
      threadId: "thread-1",
      providerThreadId: "provider-thread-1",
      scope: turnScope("turn-1"),
      item: {
        type: "plan",
        id: itemId,
        text,
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

function turnCompletedEvent({
  errorMessage,
  seq,
  status = "completed",
}: TurnCompletedEventArgs): ThreadEventWithMeta {
  return {
    event: {
      type: "turn/completed",
      threadId: "thread-1",
      providerThreadId: "provider-thread-1",
      scope: turnScope("turn-1"),
      status,
      ...(errorMessage ? { error: { message: errorMessage } } : {}),
    },
    meta: {
      id: `event-${seq}`,
      seq,
      createdAt: seq,
    },
  };
}

function backgroundTaskStartedEvent({
  description,
  id,
  parentToolCallId,
  seq,
  taskType,
}: BackgroundTaskStartedEventArgs): ThreadEventWithMeta {
  const item: ThreadEventBackgroundTaskItem = {
    type: "backgroundTask",
    id,
    taskType,
    description,
    status: "pending",
    taskStatus: "running",
    skipTranscript: false,
    parentToolCallId,
  };
  return {
    event: {
      type: "item/started",
      threadId: "thread-1",
      providerThreadId: "provider-thread-1",
      scope: turnScope("turn-1"),
      item,
    },
    meta: {
      id: `event-${seq}`,
      seq,
      createdAt: seq,
    },
  };
}

function systemOperationEvent({
  message,
  metadata,
  operation = "ownership_change",
  operationId = "operation-1",
  seq,
  status = "completed",
}: SystemOperationEventArgs): ThreadEventWithMeta {
  return {
    event: {
      type: "system/operation",
      threadId: "thread-1",
      scope: threadScope(),
      message,
      operation,
      operationId,
      status,
      ...(metadata ? { metadata } : {}),
    },
    meta: {
      id: `event-${seq}`,
      seq,
      createdAt: seq,
    },
  };
}

function systemErrorEvent({
  code,
  detail,
  message,
  seq,
}: SystemErrorEventArgs): ThreadEventWithMeta {
  return {
    event: {
      type: "system/error",
      threadId: "thread-1",
      scope: threadScope(),
      message,
      ...(code !== undefined ? { code } : {}),
      ...(detail !== undefined ? { detail } : {}),
    },
    meta: {
      id: `event-${seq}`,
      seq,
      createdAt: seq,
    },
  };
}

function systemProviderTurnWatchdogEvent({
  activeTurnId = "turn-1",
  activeTurnStartedAt = 1,
  elapsedMs = 901_000,
  firedAt,
  lastActivityEventAt = 100,
  lastActivityEventSequence = 2,
  lastActivityEventType = "turn/input/accepted",
  providerId = "codex",
  providerThreadId = "provider-thread-1",
  seq,
  thresholdMs = 900_000,
}: SystemProviderTurnWatchdogEventArgs): ThreadEventWithMeta {
  return {
    event: {
      type: "system/provider-turn-watchdog",
      threadId: "thread-1",
      scope: threadScope(),
      reason: "provider-turn-idle",
      thresholdMs,
      elapsedMs,
      activeTurnId,
      activeTurnStartedAt,
      lastActivityEventSequence,
      lastActivityEventType,
      lastActivityEventAt,
      providerId,
      providerThreadId,
      firedAt: firedAt ?? seq,
    },
    meta: {
      id: `event-${seq}`,
      seq,
      createdAt: seq,
    },
  };
}

function providerErrorEvent({
  detail,
  errorInfo,
  message = "Provider error",
  seq,
  willRetry,
}: ProviderErrorEventArgs): ThreadEventWithMeta {
  return {
    event: {
      type: "provider/error",
      threadId: "thread-1",
      providerThreadId: "provider-thread-1",
      scope: turnScope("turn-1"),
      message,
      ...(detail !== undefined ? { detail } : {}),
      ...(errorInfo !== undefined ? { errorInfo } : {}),
      ...(willRetry !== undefined ? { willRetry } : {}),
    },
    meta: {
      id: `event-${seq}`,
      seq,
      createdAt: seq,
    },
  };
}

function permissionGrantLifecycleEvent({
  interactionId = "pi-permission-grant",
  resolution = null,
  seq,
  status = "pending",
  statusReason = null,
  toolName = "Bash",
}: PermissionGrantLifecycleEventArgs): ThreadEventWithMeta {
  return {
    event: {
      type: "system/interaction/lifecycle",
      threadId: "thread-1",
      scope: turnScope("turn-1"),
      interaction: {
        id: interactionId,
        status,
        statusReason,
        origin: {
          kind: "provider",
          providerId: "codex",
          providerRequestId: "request-permission-grant",
        },
        payload: {
          kind: "approval",
          reason: null,
          subject: {
            kind: "permission_grant",
            itemId: "item-permission-grant",
            toolName,
            permissions: {
              network: { enabled: true },
              fileSystem: null,
            },
          },
        },
        resolution,
      },
    },
    meta: {
      id: `event-${seq}`,
      seq,
      createdAt: seq,
    },
  };
}

function userQuestionLifecycleEvent({
  interactionId = "pi-user-question",
  questionPrompt,
  resolution = null,
  seq,
  status = "pending",
  statusReason = null,
}: UserQuestionLifecycleEventArgs): ThreadEventWithMeta {
  return {
    event: {
      type: "system/interaction/lifecycle",
      threadId: "thread-1",
      scope: turnScope("turn-1"),
      interaction: {
        id: interactionId,
        status,
        statusReason,
        origin: {
          kind: "provider",
          providerId: "claude-code",
          providerRequestId: "request-user-question",
        },
        payload: {
          kind: "user_question",
          questions: [
            {
              id: "question-1",
              prompt: questionPrompt ?? "Which deployment target should I use?",
              shortLabel: "Target",
              multiSelect: false,
              options: [
                { value: "staging", label: "Staging" },
                { value: "production", label: "Production" },
              ],
              allowFreeText: true,
            },
          ],
        },
        resolution,
      },
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
    acceptedClientRequestContext: EMPTY_ACCEPTED_CLIENT_REQUEST_CONTEXT,
    contextWindowEvents,
    events: [],
    options: {
      includeNestedRows: false,
      includeProviderUnhandledOperations: false,
      isLatestPage: true,
      threadStatus: "idle",
      threadName: "",
      turnMessageDetail: "summary",
      workspaceRoot: null,
    },
  }).contextWindowUsage;
}

function buildTimelineRows(
  events: ThreadEventWithMeta[],
  threadStatus: BuildTimelineRowsThreadStatus = "idle",
  workspaceRoot: string | null = null,
): TimelineRow[] {
  return buildThreadTimelineFromEvents({
    acceptedClientRequestContext: EMPTY_ACCEPTED_CLIENT_REQUEST_CONTEXT,
    contextWindowEvents: [],
    events,
    options: {
      includeNestedRows: true,
      includeProviderUnhandledOperations: false,
      isLatestPage: true,
      threadStatus,
      threadName: "",
      turnMessageDetail: "full",
      workspaceRoot,
    },
  }).rows;
}

function buildTimelineRowsWithAcceptedContext(
  events: ThreadEventWithMeta[],
  acceptedClientRequestEvents: ThreadEventWithMeta[],
): TimelineRow[] {
  return buildThreadTimelineFromEvents({
    acceptedClientRequestContext: {
      acceptedClientRequestEvents,
      rejectedClientRequestEvents: [],
    },
    contextWindowEvents: [],
    events,
    options: {
      includeNestedRows: true,
      includeProviderUnhandledOperations: false,
      isLatestPage: true,
      threadStatus: "idle",
      threadName: "",
      turnMessageDetail: "full",
      workspaceRoot: null,
    },
  }).rows;
}

function buildTimelineRowsWithRejectedContext(
  events: ThreadEventWithMeta[],
  rejectedClientRequestEvents: ThreadEventWithMeta[],
): TimelineRow[] {
  return buildThreadTimelineFromEvents({
    acceptedClientRequestContext: {
      acceptedClientRequestEvents: [],
      rejectedClientRequestEvents,
    },
    contextWindowEvents: [],
    events,
    options: {
      includeNestedRows: true,
      includeProviderUnhandledOperations: false,
      isLatestPage: true,
      threadStatus: "idle",
      threadName: "",
      turnMessageDetail: "full",
      workspaceRoot: null,
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

function collectDelegationRows(
  rows: readonly TimelineRow[],
): TimelineDelegationWorkRow[] {
  const delegationRows: TimelineDelegationWorkRow[] = [];
  for (const row of rows) {
    if (row.kind === "work" && row.workKind === "delegation") {
      delegationRows.push(row);
      delegationRows.push(...collectDelegationRows(row.childRows));
      continue;
    }
    if (row.kind === "turn" && row.children) {
      delegationRows.push(...collectDelegationRows(row.children));
    }
  }
  return delegationRows;
}

function collectWorkflowRows(
  rows: readonly TimelineRow[],
): TimelineWorkflowRow[] {
  const workflowRows: TimelineWorkflowRow[] = [];
  for (const row of rows) {
    if (row.kind === "work" && row.workKind === "workflow") {
      workflowRows.push(row);
      continue;
    }
    if (row.kind === "turn" && row.children) {
      workflowRows.push(...collectWorkflowRows(row.children));
      continue;
    }
    if (row.kind === "work" && row.workKind === "delegation") {
      workflowRows.push(...collectWorkflowRows(row.childRows));
    }
  }
  return workflowRows;
}

function collectApprovalRows(
  rows: readonly TimelineRow[],
): TimelineApprovalWorkRow[] {
  const approvalRows: TimelineApprovalWorkRow[] = [];
  for (const row of rows) {
    if (row.kind === "work" && row.workKind === "approval") {
      approvalRows.push(row);
      continue;
    }
    if (row.kind === "turn" && row.children) {
      approvalRows.push(...collectApprovalRows(row.children));
      continue;
    }
    if (row.kind === "work" && row.workKind === "delegation") {
      approvalRows.push(...collectApprovalRows(row.childRows));
    }
  }
  return approvalRows;
}

function collectQuestionRows(
  rows: readonly TimelineRow[],
): TimelineQuestionWorkRow[] {
  const questionRows: TimelineQuestionWorkRow[] = [];
  for (const row of rows) {
    if (row.kind === "work" && row.workKind === "question") {
      questionRows.push(row);
      continue;
    }
    if (row.kind === "turn" && row.children) {
      questionRows.push(...collectQuestionRows(row.children));
      continue;
    }
    if (row.kind === "work" && row.workKind === "delegation") {
      questionRows.push(...collectQuestionRows(row.childRows));
    }
  }
  return questionRows;
}

function collectImageViewRows(
  rows: readonly TimelineRow[],
): TimelineImageViewWorkRow[] {
  const imageViewRows: TimelineImageViewWorkRow[] = [];
  for (const row of rows) {
    if (row.kind === "work" && row.workKind === "image-view") {
      imageViewRows.push(row);
      continue;
    }
    if (row.kind === "turn" && row.children) {
      imageViewRows.push(...collectImageViewRows(row.children));
      continue;
    }
    if (row.kind === "work" && row.workKind === "delegation") {
      imageViewRows.push(...collectImageViewRows(row.childRows));
    }
  }
  return imageViewRows;
}

function collectConversationRows(
  rows: readonly TimelineRow[],
): TimelineConversationRow[] {
  const conversationRows: TimelineConversationRow[] = [];
  for (const row of rows) {
    if (row.kind === "conversation") {
      conversationRows.push(row);
      continue;
    }
    if (row.kind === "turn" && row.children) {
      conversationRows.push(...collectConversationRows(row.children));
      continue;
    }
    if (row.kind === "work" && row.workKind === "delegation") {
      conversationRows.push(...collectConversationRows(row.childRows));
    }
  }
  return conversationRows;
}

function collectSystemRows(rows: readonly TimelineRow[]): TimelineSystemRow[] {
  const systemRows: TimelineSystemRow[] = [];
  for (const row of rows) {
    if (row.kind === "system") {
      systemRows.push(row);
      continue;
    }
    if (row.kind === "turn" && row.children) {
      systemRows.push(...collectSystemRows(row.children));
      continue;
    }
    if (row.kind === "work" && row.workKind === "delegation") {
      systemRows.push(...collectSystemRows(row.childRows));
    }
  }
  return systemRows;
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
  it("renders one turn when daemon retry history contains duplicate turn starts", () => {
    const rows = buildTimelineRows([
      turnStartedEvent({ seq: 1 }),
      turnStartedEvent({ seq: 2 }),
      toolCallItemEvent({
        seq: 3,
        tool: "read",
        type: "item/started",
      }),
      toolCallItemEvent({
        result: "ok",
        seq: 4,
        tool: "read",
        type: "item/completed",
      }),
      turnCompletedEvent({ seq: 5 }),
    ]);

    expect(rows.filter((row) => row.kind === "turn")).toHaveLength(1);
    expect(collectToolRows(rows)).toHaveLength(1);
  });

  it.each(["read", "grep", "glob", "Read", "Grep", "Glob"])(
    "renders a %s tool call as a generic tool row: no tool-name table derives an intent",
    (tool) => {
      const toolArgs = { path: "src/app.ts", pattern: "TODO" };
      const rows = buildTimelineRows([
        turnStartedEvent({ seq: 1 }),
        toolCallItemEvent({ seq: 2, tool, toolArgs, type: "item/started" }),
        toolCallItemEvent({
          result: "ok",
          seq: 3,
          tool,
          toolArgs,
          type: "item/completed",
        }),
      ]);
      const [row] = collectToolRows(rows);
      expect(row).toBeDefined();
      if (!row) {
        throw new Error(`Expected a projected ${tool} tool row`);
      }
      expect(
        buildTimelineRowTitle(row, {
          summaryStyle: "bundle",
          workStyle: "default",
        }).plain,
      ).toBe(`Ran tool ${tool} { path: src/app.ts, pattern: TODO }`);
    },
  );

  it("drops a statusLabels key a row persisted before the field was deleted", () => {
    const rows = buildTimelineRows([
      turnStartedEvent({ seq: 1 }),
      toolCallItemEvent({
        statusLabels: { pending: "Reading", completed: "Read" },
        seq: 2,
        tool: "repository_context",
        type: "item/completed",
      }),
    ]);
    const [row] = collectToolRows(rows);
    expect(row).toEqual(
      expect.objectContaining({
        status: "completed",
        toolName: "repository_context",
      }),
    );
    expect(row).not.toHaveProperty("statusLabels");
  });

  it("extracts the exact active Plan turn id from the accepted input scope", () => {
    const event = createTimelineEventFactory({ threadId: "thread-1" });
    const requestId = "creq_23456789ab";
    const events = fromRows([
      event.clientTurnRequested({
        requestId,
        text: "/plan inspect the failing command",
        input: planPromptInput,
      }),
      event.turnStarted({ turnId: "turn-plan-42" }),
      event.inputAccepted({
        clientRequestId: requestId,
        turnId: "turn-plan-42",
      }),
    ]);

    expect(
      extractThreadTimelineActivePlanTurn({
        events,
        planCommand: { trigger: "/", name: "plan" },
        providerId: "codex",
        threadStatus: "active",
      }),
    ).toEqual({
      promptMode: {
        mode: "plan",
        providerId: "codex",
        prompt: "inspect the failing command",
      },
      turnId: "turn-plan-42",
    });
  });

  it("gates plan mode on the declared plan command, not the provider id", () => {
    const event = createTimelineEventFactory({ threadId: "thread-1" });
    const requestId = "creq_3456789abc";
    const events = fromRows([
      event.clientTurnRequested({
        requestId,
        text: "/plan inspect the failing command",
        input: planPromptInput,
      }),
      event.turnStarted({ turnId: "turn-plan-43" }),
      event.inputAccepted({
        clientRequestId: requestId,
        turnId: "turn-plan-43",
      }),
    ]);

    expect(
      extractThreadTimelineActivePlanTurn({
        events,
        planCommand: { trigger: "/", name: "plan" },
        providerId: "my-plugin-provider",
        threadStatus: "active",
      })?.promptMode.providerId,
    ).toBe("my-plugin-provider");
    expect(
      extractThreadTimelineActivePlanTurn({
        events,
        planCommand: null,
        providerId: "codex",
        threadStatus: "active",
      }),
    ).toBeNull();
  });

  it("projects active Claude plan mode from an accepted plan command pill", () => {
    const event = createTimelineEventFactory({ threadId: "thread-1" });
    const requestId = "creq_23456789ab";

    const timeline = buildThreadTimelineFromEvents({
      acceptedClientRequestContext: EMPTY_ACCEPTED_CLIENT_REQUEST_CONTEXT,
      contextWindowEvents: [],
      events: fromRows([
        event.clientTurnRequested({
          requestId,
          text: "/plan inspect the failing command",
          input: planPromptInput,
        }),
        event.turnStarted(),
        event.inputAccepted({ clientRequestId: requestId }),
      ]),
      options: {
        includeNestedRows: true,
        includeProviderUnhandledOperations: false,
        isLatestPage: true,
        planCommand: { trigger: "/", name: "plan" },
        providerId: "claude-code",
        threadStatus: "active",
        threadName: "",
        turnMessageDetail: "full",
        workspaceRoot: null,
      },
    });

    expect(timeline.activePromptMode).toEqual({
      mode: "plan",
      providerId: "claude-code",
      prompt: "inspect the failing command",
    });
  });

  it("projects active Codex plan mode from an accepted plan command pill", () => {
    const event = createTimelineEventFactory({ threadId: "thread-1" });
    const requestId = "creq_23456789ab";

    const timeline = buildThreadTimelineFromEvents({
      acceptedClientRequestContext: EMPTY_ACCEPTED_CLIENT_REQUEST_CONTEXT,
      contextWindowEvents: [],
      events: fromRows([
        event.clientTurnRequested({
          requestId,
          text: "/plan inspect the failing command",
          input: planPromptInput,
        }),
        event.turnStarted(),
        event.inputAccepted({ clientRequestId: requestId }),
      ]),
      options: {
        includeNestedRows: true,
        includeProviderUnhandledOperations: false,
        isLatestPage: true,
        planCommand: { trigger: "/", name: "plan" },
        providerId: "codex",
        threadStatus: "active",
        threadName: "",
        turnMessageDetail: "full",
        workspaceRoot: null,
      },
    });

    expect(timeline.activePromptMode).toEqual({
      mode: "plan",
      providerId: "codex",
      prompt: "inspect the failing command",
    });
  });

  it("does not project active plan mode from plain text", () => {
    const event = createTimelineEventFactory({ threadId: "thread-1" });
    const requestId = "creq_23456789ab";

    const timeline = buildThreadTimelineFromEvents({
      acceptedClientRequestContext: EMPTY_ACCEPTED_CLIENT_REQUEST_CONTEXT,
      contextWindowEvents: [],
      events: fromRows([
        event.clientTurnRequested({
          requestId,
          text: "/plan inspect the failing command",
        }),
        event.turnStarted(),
        event.inputAccepted({ clientRequestId: requestId }),
      ]),
      options: {
        includeNestedRows: true,
        includeProviderUnhandledOperations: false,
        isLatestPage: true,
        planCommand: { trigger: "/", name: "plan" },
        providerId: "claude-code",
        threadStatus: "active",
        threadName: "",
        turnMessageDetail: "full",
        workspaceRoot: null,
      },
    });

    expect(timeline.activePromptMode).toBeNull();
  });

  it("clears active Claude plan mode when the turn completes", () => {
    const event = createTimelineEventFactory({ threadId: "thread-1" });
    const requestId = "creq_23456789ab";

    const timeline = buildThreadTimelineFromEvents({
      acceptedClientRequestContext: EMPTY_ACCEPTED_CLIENT_REQUEST_CONTEXT,
      contextWindowEvents: [],
      events: fromRows([
        event.clientTurnRequested({
          requestId,
          text: "/plan inspect the failing command",
          input: planPromptInput,
        }),
        event.turnStarted(),
        event.inputAccepted({ clientRequestId: requestId }),
        event.turnCompleted(),
      ]),
      options: {
        includeNestedRows: true,
        includeProviderUnhandledOperations: false,
        isLatestPage: true,
        planCommand: { trigger: "/", name: "plan" },
        providerId: "claude-code",
        threadStatus: "idle",
        threadName: "",
        turnMessageDetail: "full",
        workspaceRoot: null,
      },
    });

    expect(timeline.activePromptMode).toBeNull();
  });

  it("makes a persisted call a delegation when rows name it as their parent, whatever its tool name", () => {
    const event = createTimelineEventFactory({
      threadId: "thread-1",
      turnId: "turn-1",
    });
    const parentToolCallId = "call-helper-1";
    const rows = buildTimelineRows(
      fromRows([
        event.turnStarted({ seq: 1 }),
        event.toolCallStarted({
          seq: 2,
          itemId: parentToolCallId,
          tool: "spawn_helper",
          arguments: {
            description: "Audit the docs",
            subagent_type: "reviewer",
            model: "fast",
          },
        }),
        event.assistantCompleted({
          seq: 3,
          itemId: "helper-progress",
          parentToolCallId,
          text: "Read 3 files",
        }),
        event.toolCallCompleted({
          seq: 4,
          itemId: parentToolCallId,
          tool: "spawn_helper",
          result: "done",
        }),
      ]),
    );

    const [delegation] = collectDelegationRows(rows);
    expect(delegation).toMatchObject({
      id: "thread-1:delegation:call-helper-1",
      toolName: "spawn_helper",
      description: "Audit the docs",
      subagentType: "reviewer",
      childRef: null,
      background: false,
      status: "completed",
    });
    expect(delegation?.childRows).toEqual([
      expect.objectContaining({
        kind: "conversation",
        role: "assistant",
        text: "Read 3 files",
      }),
    ]);
    expect(
      buildTimelineRows(
        fromRows([
          event.turnStarted({ seq: 1 }),
          event.toolCallCompleted({
            seq: 2,
            itemId: "lonely",
            tool: "spawn_helper",
          }),
        ]),
      ).some((row) => row.kind === "work" && row.workKind === "delegation"),
    ).toBe(false);
  });

  it("keeps a persisted, presentation-less Agent call a delegation when no row names it as parent", () => {
    const event = createTimelineEventFactory({
      threadId: "thread-1",
      turnId: "turn-1",
    });
    const childless: ReadonlyArray<{
      status: "failed" | "completed";
      result: string;
      verb: string;
    }> = [
      {
        status: "failed",
        result:
          "InputValidationError: Agent failed due to the following issue:\nThe required parameter `prompt` is missing",
        verb: "Failed subagent:",
      },
      {
        status: "completed",
        result: "agentId: a1\nDone.",
        verb: "Ran subagent:",
      },
    ];
    for (const { status, result, verb } of childless) {
      const rows = buildTimelineRows(
        fromRows([
          event.turnStarted({ seq: 1 }),
          event.toolCallStarted({
            seq: 2,
            itemId: "toolu_agent_1",
            tool: "Agent",
            arguments: {
              description: "Review the diff",
              subagent_type: "reviewer",
              model: "fast",
            },
          }),
          event.toolCallCompleted({
            seq: 3,
            itemId: "toolu_agent_1",
            tool: "Agent",
            arguments: {
              description: "Review the diff",
              subagent_type: "reviewer",
              model: "fast",
            },
            status,
            result,
          }),
        ]),
      );
      const [delegation] = collectDelegationRows(rows);
      expect(delegation, status).toMatchObject({
        id: "thread-1:delegation:toolu_agent_1",
        toolName: "Agent",
        description: "Review the diff",
        subagentType: "reviewer",
        childRef: null,
        background: false,
        status: status === "failed" ? "error" : "completed",
        childRows: [],
      });
      expect(
        buildTimelineRowTitle(delegation!, {
          summaryStyle: "bundle",
          workStyle: "default",
        }).segments.map((segment) => segment.text),
      ).toEqual([verb, "Review the diff", "(reviewer)"]);
      expect(collectToolRows(rows)).toEqual([]);
    }

    const childful = collectDelegationRows(
      buildTimelineRows(
        fromRows([
          event.turnStarted({ seq: 1 }),
          event.toolCallStarted({
            seq: 2,
            itemId: "toolu_agent_2",
            tool: "Agent",
            arguments: {
              description: "Audit the docs",
              subagent_type: "reviewer",
            },
          }),
          event.assistantCompleted({
            seq: 3,
            itemId: "child-text",
            parentToolCallId: "toolu_agent_2",
            text: "Read 3 files",
          }),
          event.toolCallCompleted({
            seq: 4,
            itemId: "toolu_agent_2",
            tool: "Agent",
            result: "done",
          }),
        ]),
      ),
    );
    expect(childful).toHaveLength(1);
    expect(childful[0]).toMatchObject({
      id: "thread-1:delegation:toolu_agent_2",
      toolName: "Agent",
      description: "Audit the docs",
      subagentType: "reviewer",
      childRef: null,
      status: "completed",
    });
    expect(childful[0]?.childRows).toEqual([
      expect.objectContaining({ kind: "conversation", text: "Read 3 files" }),
    ]);

    const presented = buildTimelineRows(
      fromRows([
        event.turnStarted({ seq: 1 }),
        event.toolCallCompleted({
          seq: 2,
          itemId: "presented-agent",
          tool: "Agent",
          arguments: { description: "Not a delegation" },
          presentation: {
            label: { pending: "Running Agent", completed: "Ran Agent" },
            icon: { glyph: "Toolbox" },
          },
        }),
        event.toolCallCompleted({
          seq: 3,
          itemId: "plain-bash",
          tool: "Bash",
          arguments: { command: "ls" },
        }),
      ]),
    );
    expect(collectDelegationRows(presented)).toEqual([]);
    expect(collectToolRows(presented).map((row) => row.id)).toEqual([
      "thread-1:tool:presented-agent",
      "thread-1:tool:plain-bash",
    ]);
  });

  it("omits duplicated background-agent lifecycle rows from delegation children", () => {
    const event = createTimelineEventFactory({
      threadId: "thread-1",
      turnId: "turn-1",
    });
    const parentToolCallId = "toolu-agent-1";
    const subagentDescription = "Build Direction A Tools hub Ladle story";
    const rows = buildTimelineRows([
      ...fromRows([
        event.turnStarted({ seq: 1 }),
        event.toolCallStarted({
          seq: 2,
          itemId: parentToolCallId,
          tool: "Agent",
          arguments: {
            description: subagentDescription,
            prompt: subagentDescription,
          },
        }),
      ]),
      backgroundTaskStartedEvent({
        seq: 3,
        id: "task:subagent",
        taskType: "local_agent",
        description: subagentDescription,
        parentToolCallId,
      }),
      backgroundTaskStartedEvent({
        seq: 4,
        id: "task:workflow",
        taskType: "local_workflow",
        description: "Collect screenshots",
        parentToolCallId,
      }),
      ...fromRows([
        event.assistantCompleted({
          seq: 5,
          itemId: "subagent-progress",
          parentToolCallId,
          text: "Explored 19 files, 1 list, 4 searches",
        }),
      ]),
    ]);

    const [delegation] = collectDelegationRows(rows);

    expect(delegation).toBeDefined();
    if (!delegation) {
      throw new Error("Expected a delegation row");
    }
    expect(
      collectWorkflowRows(delegation.childRows).map((row) => row.taskType),
    ).toEqual(["local_workflow"]);
    expect(delegation.childRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "conversation",
          role: "assistant",
          text: "Explored 19 files, 1 list, 4 searches",
        }),
      ]),
    );
  });

  it("keeps nested Claude agents out of root active-work rows", () => {
    const events = [
      turnStartedEvent({ seq: 1 }),
      toolCallItemEvent({
        seq: 2,
        itemId: "root-agent-call",
        tool: "Agent",
        type: "item/started",
      }),
      toolCallItemEvent({
        seq: 3,
        itemId: "nested-agent-call",
        parentToolCallId: "root-agent-call",
        tool: "Agent",
        type: "item/started",
      }),
      backgroundTaskStartedEvent({
        seq: 4,
        id: "task:nested-agent",
        taskType: "local_agent",
        description: "Nested Claude agent still running",
        parentToolCallId: "nested-agent-call",
      }),
      turnCompletedEvent({ seq: 5 }),
    ];

    const timeline = buildThreadTimelineFromEvents({
      acceptedClientRequestContext: EMPTY_ACCEPTED_CLIENT_REQUEST_CONTEXT,
      contextWindowEvents: [],
      events,
      options: {
        includeNestedRows: true,
        includeProviderUnhandledOperations: false,
        isLatestPage: true,
        planCommand: { trigger: "/", name: "plan" },
        providerId: "claude-code",
        threadStatus: "idle",
        threadName: "",
        turnMessageDetail: "full",
        workspaceRoot: null,
      },
    });

    expect(timeline.activeBackgroundCommands).toEqual([]);
  });

  it("does not project thread-start provider-session markers as provisioning rows", () => {
    const event = createTimelineEventFactory({ threadId: "thread-1" });
    const providerSessionMarker = event.threadProvisioning({
      provisioningId: "thread-start:exec_1",
      status: "completed",
      entries: [],
    });

    const rows = buildTimelineRows(
      fromRows([
        event.threadProvisioning({
          provisioningId: "tpv-real",
          status: "completed",
          entries: [],
        }),
        providerSessionMarker,
      ]),
    );

    expect(
      collectSystemRows(rows).filter(
        (row) =>
          row.systemKind === "operation" && row.title === "Provisioned thread",
      ),
    ).toHaveLength(1);
  });

  it("normalizes carriage-return provisioning output in operation detail", () => {
    const event = createTimelineEventFactory({ threadId: "thread-1" });
    const rows = buildTimelineRows(
      fromRows([
        event.threadProvisioning({
          status: "active",
          entries: [
            {
              type: "output",
              key: "git-worktree-output-1",
              text: [
                "Preparing worktree (new branch 'bb/example')\n",
                "Updating files:  44% (1017/2287)\r",
                "Updating files:  45% (1030/2287)\r",
                "Updating files: 100% (2287/2287), done.",
              ].join(""),
            },
          ],
        }),
      ]),
    );

    const [row] = rows;
    if (!row || row.kind !== "system") {
      throw new Error("Expected a system row");
    }

    expect(row.detail).toBe(
      [
        "Preparing worktree (new branch 'bb/example')",
        "Updating files: 100% (2287/2287), done.",
      ].join("\n"),
    );
    expect(row.detail).not.toContain("44%");
    expect(row.detail).not.toContain("\r");
  });

  it("projects image view item events as timeline work rows", () => {
    const completedRows = buildTimelineRows([
      turnStartedEvent({ seq: 1 }),
      imageViewItemEvent({
        seq: 2,
        type: "item/started",
      }),
      imageViewItemEvent({
        seq: 3,
        type: "item/completed",
      }),
    ]);
    const [completedRow] = collectImageViewRows(completedRows);
    if (!completedRow) {
      throw new Error("Expected an image view row");
    }

    expect(completedRow).toMatchObject({
      workKind: "image-view",
      callId: "image-view-1",
      path: "/tmp/sightglass-quote-merge-check/dashboard-main.png",
      status: "completed",
      completedAt: 3,
    });

    const pendingRows = buildTimelineRows(
      [
        turnStartedEvent({ seq: 4 }),
        imageViewItemEvent({
          seq: 5,
          type: "item/started",
        }),
      ],
      "active",
    );
    const [pendingRow] = collectImageViewRows(pendingRows);
    if (!pendingRow) {
      throw new Error("Expected an image view row");
    }

    expect(pendingRow).toMatchObject({
      workKind: "image-view",
      status: "pending",
      completedAt: null,
    });
  });

  it("interrupts a pending image view row when its turn is interrupted", () => {
    const rows = buildTimelineRows([
      turnStartedEvent({ seq: 1 }),
      imageViewItemEvent({
        seq: 2,
        type: "item/started",
      }),
      turnCompletedEvent({
        seq: 3,
        status: "interrupted",
      }),
    ]);

    const imageViewRows = collectImageViewRows(rows);
    expect(imageViewRows).toEqual([
      expect.objectContaining({
        callId: "image-view-1",
        status: "interrupted",
        startedAt: 2,
        completedAt: 3,
      }),
    ]);
  });

  it("completes an image view row after its start has flushed to history", () => {
    const rows = buildTimelineRows([
      turnStartedEvent({ seq: 1 }),
      imageViewItemEvent({
        seq: 2,
        type: "item/started",
      }),
      toolCallItemEvent({
        itemId: "tool-call-1",
        seq: 3,
        tool: "Read",
        toolArgs: { file_path: "apps/app/src/main.tsx" },
        type: "item/started",
      }),
      imageViewItemEvent({
        seq: 4,
        type: "item/completed",
      }),
    ]);

    const imageViewRows = collectImageViewRows(rows);
    expect(imageViewRows).toEqual([
      expect.objectContaining({
        callId: "image-view-1",
        status: "completed",
        startedAt: 2,
        completedAt: 4,
        sourceSeqEnd: 4,
      }),
    ]);
  });

  it("keeps an out-of-order image view completion finalized when its start replays later", () => {
    const rows = buildTimelineRows([
      turnStartedEvent({ seq: 1 }),
      imageViewItemEvent({
        seq: 2,
        type: "item/completed",
      }),
      imageViewItemEvent({
        seq: 3,
        type: "item/started",
      }),
    ]);

    const imageViewRows = collectImageViewRows(rows);
    expect(imageViewRows).toEqual([
      expect.objectContaining({
        callId: "image-view-1",
        status: "completed",
        startedAt: 2,
        completedAt: 2,
        sourceSeqEnd: 2,
      }),
    ]);
  });

  it("ignores duplicate image view lifecycle replays after finalization", () => {
    const rows = buildTimelineRows([
      turnStartedEvent({ seq: 1 }),
      imageViewItemEvent({
        seq: 2,
        type: "item/started",
      }),
      imageViewItemEvent({
        seq: 3,
        type: "item/completed",
      }),
      imageViewItemEvent({
        seq: 4,
        type: "item/started",
      }),
      imageViewItemEvent({
        seq: 5,
        type: "item/completed",
      }),
    ]);

    const imageViewRows = collectImageViewRows(rows);
    expect(imageViewRows).toEqual([
      expect.objectContaining({
        callId: "image-view-1",
        status: "completed",
        startedAt: 2,
        completedAt: 3,
        sourceSeqEnd: 3,
      }),
    ]);
  });

  it("uses accepted context to suppress pending steers without rendering future accepted rows", () => {
    const event = createTimelineEventFactory({ threadId: "thread-1" });
    const turnStarted = event.turnStarted({ turnId: "turn-1" });
    const steerRequest = event.clientTurnRequested({
      target: { kind: "auto", expectedTurnId: "turn-1" },
      text: "Please account for the restart",
    });
    const acceptedContext = fromRows([
      event.inputAccepted({
        clientRequestId: steerRequest.data.requestId,
        turnId: "turn-1",
      }),
    ]);

    const rows = buildTimelineRowsWithAcceptedContext(
      fromRows([turnStarted, steerRequest]),
      acceptedContext,
    );

    expect(
      rows.filter((row) => row.kind === "conversation" && row.role === "user"),
    ).toHaveLength(0);
  });

  it("uses rejected context to render a failed steer across a page boundary", () => {
    const event = createTimelineEventFactory({ threadId: "thread-1" });
    const steerRequest = event.clientTurnRequested({
      target: { kind: "steer", expectedTurnId: "turn-1" },
      text: "Late steer",
    });
    const rejectedContext = fromRows([
      event.clientTurnRejected({ requestId: steerRequest.data.requestId }),
    ]);

    const rows = buildTimelineRowsWithRejectedContext(
      fromRows([event.turnStarted({ turnId: "turn-1" }), steerRequest]),
      rejectedContext,
    );

    expect(
      rows.find((row) => row.kind === "conversation" && row.role === "user"),
    ).toMatchObject({
      text: "Late steer",
      turnRequest: { status: "rejected" },
    });
  });

  it("uses accepted context to classify stale steers as messages when the accepted turn is visible", () => {
    const event = createTimelineEventFactory({ threadId: "thread-1" });
    const turnStarted = event.turnStarted({ turnId: "turn-1" });
    const steerRequest = event.clientTurnRequested({
      target: { kind: "auto", expectedTurnId: "turn-1" },
      text: "Start a fresh attempt",
    });
    const fallbackTurnStarted = event.turnStarted({ turnId: "turn-2" });
    const acceptedContext = fromRows([
      event.inputAccepted({
        clientRequestId: steerRequest.data.requestId,
        turnId: "turn-2",
      }),
    ]);

    const rows = buildTimelineRowsWithAcceptedContext(
      fromRows([turnStarted, steerRequest, fallbackTurnStarted]),
      acceptedContext,
    );
    const userRows = rows.filter(
      (row) => row.kind === "conversation" && row.role === "user",
    );

    expect(userRows).toHaveLength(1);
    expect(userRows[0]).toMatchObject({
      text: "Start a fresh attempt",
      turnRequest: {
        kind: "message",
        status: "accepted",
      },
    });
  });

  it("renders completed provider plan items as assistant conversation text", () => {
    const rows = buildTimelineRows([
      turnStartedEvent({ seq: 0 }),
      planDeltaEvent({ seq: 1, text: "Draft plan text" }),
      planItemCompletedEvent({
        seq: 2,
        text: "Final plan text",
      }),
      turnCompletedEvent({ seq: 3 }),
    ]);

    const assistantRows = collectConversationRows(rows).filter(
      (row) => row.role === "assistant",
    );
    expect(assistantRows).toEqual([
      expect.objectContaining({
        text: "Final plan text",
        sourceSeqStart: 1,
        sourceSeqEnd: 2,
      }),
    ]);
  });

  it.each(ownershipOperationCases)(
    "uses $action ownership metadata rather than event message for operation titles",
    ({
      action,
      message,
      nextParentThreadId,
      nextParentThreadTitle,
      previousParentThreadId,
      previousParentThreadTitle,
    }) => {
      const event = systemOperationEvent({
        message: "Ownership operation completed",
        metadata: {
          action,
          nextParentThreadId,
          nextParentThreadTitle,
          previousParentThreadId,
          previousParentThreadTitle,
        },
        seq: 1,
      });

      expect(parseOperationMessage(event.event, event.meta)).toMatchObject({
        kind: "operation",
        title: message,
      });
    },
  );

  it("uses a neutral completed ownership title for legacy metadata", () => {
    const event = systemOperationEvent({
      message: "Ownership operation completed",
      metadata: {
        action: "unknown-action",
        nextParentThreadId: null,
        nextParentThreadTitle: null,
        previousParentThreadId: null,
        previousParentThreadTitle: null,
      },
      seq: 1,
    });

    expect(parseOperationMessage(event.event, event.meta)).toMatchObject({
      kind: "operation",
      title: "Ownership change completed",
    });
  });

  it.each(ownershipOperationCases)(
    "does not duplicate $action ownership operation titles as row detail",
    ({
      action,
      parentChangeAction,
      message,
      nextParentThreadId,
      nextParentThreadTitle,
      previousParentThreadId,
      previousParentThreadTitle,
    }) => {
      const rows = buildTimelineRows([
        systemOperationEvent({
          message,
          metadata: {
            action,
            nextParentThreadId,
            nextParentThreadTitle,
            previousParentThreadId,
            previousParentThreadTitle,
          },
          seq: 1,
        }),
      ]);

      expect(collectSystemRows(rows)).toEqual([
        expect.objectContaining({
          detail: null,
          parentChange: {
            action: parentChangeAction,
            previousParentThreadId: previousParentThreadId,
            previousParentThreadTitle: previousParentThreadTitle,
            nextParentThreadId: nextParentThreadId,
            nextParentThreadTitle: nextParentThreadTitle,
          },
          operationKind: "parent-change",
          systemKind: "operation",
          title: message,
        }),
      ]);
    },
  );

  it("keeps system error message and detail as separate row fields", () => {
    const rows = buildTimelineRows([
      systemErrorEvent({
        code: "thread_command_failed",
        message: "Command thread/start failed",
        detail:
          "Error: Cannot find claude code binary\n  at resolveBinary (sdk.js:42)\n  at start (sdk.js:88)",
        seq: 1,
      }),
    ]);

    expect(collectSystemRows(rows)).toEqual([
      expect.objectContaining({
        systemKind: "error",
        status: "error",
        title: "Command thread/start failed",
        detail:
          "Error: Cannot find claude code binary\n  at resolveBinary (sdk.js:42)\n  at start (sdk.js:88)",
      }),
    ]);
  });

  it("leaves system error detail null when only message is provided", () => {
    const rows = buildTimelineRows([
      systemErrorEvent({
        code: "provider_runtime_error",
        message: "Provider runtime is unavailable",
        seq: 1,
      }),
    ]);

    expect(collectSystemRows(rows)).toEqual([
      expect.objectContaining({
        systemKind: "error",
        title: "Provider runtime is unavailable",
        detail: null,
      }),
    ]);
  });

  it("uses structured provider error info for provider error titles", () => {
    const rows = buildTimelineRows([
      turnStartedEvent({ seq: 1 }),
      providerErrorEvent({
        detail: "You've hit your limit - resets at 2:00 PM",
        errorInfo: {
          category: "rate-limit",
          providerCode: "usageLimitExceeded",
          httpStatusCode: null,
        },
        seq: 2,
      }),
    ]);

    expect(collectSystemRows(rows)).toEqual([
      expect.objectContaining({
        systemKind: "error",
        status: "error",
        title: "Provider rate limit reached",
        detail: "You've hit your limit - resets at 2:00 PM",
      }),
    ]);
  });

  it("keeps error rows in the regular timeline", () => {
    const rows = buildTimelineRows([
      turnStartedEvent({ seq: 1 }),
      providerErrorEvent({
        detail: "The provider stream closed unexpectedly",
        seq: 2,
      }),
      systemErrorEvent({
        code: "thread_command_failed",
        message: "Command turn.submit failed",
        detail: "Payload exceeded provider limit",
        seq: 3,
      }),
    ]);

    expect(collectSystemRows(rows)).toEqual([
      expect.objectContaining({
        systemKind: "error",
        status: "error",
        title: "The provider stream closed unexpectedly",
      }),
      expect.objectContaining({
        systemKind: "error",
        status: "error",
        title: "Command turn.submit failed",
        detail: "Payload exceeded provider limit",
      }),
    ]);
  });

  it("uses legacy provider error detail as the title for generic provider errors", () => {
    const rows = buildTimelineRows([
      turnStartedEvent({ seq: 1 }),
      providerErrorEvent({
        detail: "API Error: Overloaded",
        seq: 2,
      }),
    ]);

    expect(collectSystemRows(rows)).toEqual([
      expect.objectContaining({
        systemKind: "error",
        status: "error",
        title: "API Error: Overloaded",
        detail: null,
      }),
    ]);
  });

  it("titles retrying provider errors with their reconnect progress, error in the body", () => {
    const rows = buildTimelineRows([
      turnStartedEvent({ seq: 1 }),
      providerErrorEvent({
        detail:
          "Reconnecting... 3/5\nstream disconnected before completion: Network is unreachable (os error 51)",
        seq: 2,
        willRetry: true,
      }),
    ]);

    expect(collectSystemRows(rows)).toEqual([
      expect.objectContaining({
        systemKind: "reconnect",
        status: null,
        title: "Reconnecting... 3/5",
        detail:
          "stream disconnected before completion: Network is unreachable (os error 51)",
      }),
    ]);
  });

  it("falls back to a generic title and keeps the full message in the body when an error is too long to read inline", () => {
    const longMessage =
      "There's an issue with the selected model (opus-4.7). It may not exist or you may not have access to it. Run --model to pick a different model.";
    const rows = buildTimelineRows([
      turnStartedEvent({ seq: 1 }),
      providerErrorEvent({ detail: longMessage, seq: 2 }),
    ]);

    expect(collectSystemRows(rows)).toEqual([
      expect.objectContaining({
        systemKind: "error",
        status: "error",
        title: "Provider error",
        detail: longMessage,
      }),
    ]);
  });

  it("renders provider turn watchdog diagnostics as an error operation row", () => {
    const rows = buildTimelineRows([
      systemProviderTurnWatchdogEvent({ seq: 1 }),
    ]);

    expect(collectSystemRows(rows)).toEqual([
      expect.objectContaining({
        systemKind: "operation",
        operationKind: "generic",
        status: "error",
        title: "Provider turn stopped responding",
        detail: "No provider activity for 901s after turn/input/accepted",
      }),
    ]);
  });

  it("uses a neutral completed ownership title for invalid ownership actions", () => {
    const rows = buildTimelineRows([
      systemOperationEvent({
        message: "Thread ownership updated by migration",
        metadata: {
          action: "migrate",
          nextParentThreadId: "thr-parent",
          nextParentThreadTitle: "Parent",
          previousParentThreadId: null,
          previousParentThreadTitle: null,
        },
        seq: 1,
      }),
    ]);

    expect(collectSystemRows(rows)).toEqual([
      expect.objectContaining({
        detail: "Thread ownership updated by migration",
        operationKind: "generic",
        systemKind: "operation",
        title: "Ownership change completed",
      }),
    ]);
    expect(collectSystemRows(rows)[0]).not.toHaveProperty("parentChange");
  });

  it("contributes no row for an interaction that shows elsewhere (a command approval, a plugin request)", () => {
    const rows = buildTimelineRows([
      {
        event: {
          type: "system/interaction/lifecycle",
          threadId: "thread-1",
          scope: turnScope("turn-1"),
          interaction: {
            id: "pi-command",
            status: "pending",
            statusReason: null,
            origin: {
              kind: "provider",
              providerId: "codex",
              providerRequestId: "request-command",
            },
            payload: {
              kind: "approval",
              reason: null,
              subject: {
                kind: "command",
                itemId: "item-command",
                command: "git push",
                cwd: null,
                actions: [],
                sessionGrant: null,
              },
            },
            resolution: null,
          },
        },
        meta: { id: "event-1", seq: 1, createdAt: 1 },
      },
      {
        event: {
          type: "system/interaction/lifecycle",
          threadId: "thread-1",
          scope: threadScope(),
          interaction: {
            id: "pint-plugin",
            status: "resolved",
            statusReason: null,
            origin: {
              kind: "plugin",
              pluginId: "secrets",
              rendererId: "secret-request",
            },
            payload: { kind: "plugin", title: "Add secrets" },
            resolution: { kind: "plugin_submitted" },
          },
        },
        meta: { id: "event-2", seq: 2, createdAt: 2 },
      },
    ]);
    expect(rows.filter((row) => row.kind === "work")).toEqual([]);
    expect(collectSystemRows(rows)).toEqual([]);
  });

  it("suppresses the legacy plugin interaction lifecycle operations", () => {
    const rows = buildTimelineRows([
      systemOperationEvent({
        message: "Plugin interaction lifecycle changed",
        operation: "plugin_interaction",
        operationId: "pint-test",
        seq: 1,
        status: "pending",
      }),
      systemOperationEvent({
        message: "Plugin interaction lifecycle changed",
        operation: "plugin_interaction",
        operationId: "pint-test",
        seq: 2,
        status: "resolved",
      }),
    ]);

    expect(collectSystemRows(rows)).toEqual([]);
  });

  it("suppresses the internal message-edit commit marker", () => {
    const rows = buildTimelineRows([
      systemOperationEvent({
        message: "Message edited",
        operation: "edit_message",
        operationId: "edit-op-test",
        seq: 1,
        status: "completed",
      }),
    ]);

    expect(collectSystemRows(rows)).toEqual([]);
  });

  it.each([
    {
      expectedRowStatus: "pending",
      operationStatus: "running",
      threadStatus: "active",
    },
    {
      expectedRowStatus: "error",
      operationStatus: "failed",
      threadStatus: "idle",
    },
  ] satisfies Array<{
    expectedRowStatus: "error" | "pending";
    operationStatus: "failed" | "running";
    threadStatus: BuildTimelineRowsThreadStatus;
  }>)(
    "keeps parent change typing for $operationStatus operation status",
    ({ expectedRowStatus, operationStatus, threadStatus }) => {
      const rows = buildTimelineRows(
        [
          systemOperationEvent({
            message: `Ownership change ${operationStatus}`,
            metadata: {
              action: "assign",
              nextParentThreadId: "thr-parent",
              nextParentThreadTitle: "Parent",
              previousParentThreadId: null,
              previousParentThreadTitle: null,
            },
            seq: 1,
            status: operationStatus,
          }),
        ],
        threadStatus,
      );

      expect(collectSystemRows(rows)).toEqual([
        expect.objectContaining({
          parentChange: {
            action: "assign",
            previousParentThreadId: null,
            previousParentThreadTitle: null,
            nextParentThreadId: "thr-parent",
            nextParentThreadTitle: "Parent",
          },
          operationKind: "parent-change",
          status: expectedRowStatus,
          systemKind: "operation",
        }),
      ]);
    },
  );

  it.each([
    {
      expectedGrantScope: "turn",
      resolution: {
        decision: "allow_once",
        grantedPermissions: {
          network: { enabled: true },
          fileSystem: null,
        },
      },
    },
    {
      expectedGrantScope: "session",
      resolution: {
        decision: "allow_for_session",
        grantedPermissions: {
          network: { enabled: true },
          fileSystem: null,
        },
      },
    },
  ] satisfies Array<{
    expectedGrantScope: "turn" | "session";
    resolution: ApprovalPendingInteractionResolution;
  }>)(
    "preserves permission grant $expectedGrantScope scope on timeline rows",
    ({ expectedGrantScope, resolution }) => {
      const rows = buildTimelineRows([
        turnStartedEvent({ seq: 0 }),
        permissionGrantLifecycleEvent({
          resolution,
          seq: 1,
          status: "resolved",
        }),
      ]);

      expect(collectApprovalRows(rows)).toEqual([
        expect.objectContaining({
          approvalKind: "permission-grant",
          grantScope: expectedGrantScope,
          lifecycle: "granted",
          statusReason: null,
          target: {
            itemId: "item-permission-grant",
            toolName: "Bash",
          },
        }),
      ]);
      expect(collectApprovalRows(rows)[0]).not.toHaveProperty("toolName");
    },
  );

  it.each([
    {
      expectedLifecycle: "interrupted",
      expectedStatus: "interrupted",
      status: "interrupted",
      statusReason: "Thread stopped by user request",
    },
  ] satisfies Array<{
    expectedLifecycle: "interrupted";
    expectedStatus: "interrupted";
    status: "interrupted";
    statusReason: string;
  }>)(
    "preserves permission grant $status status reason on timeline rows",
    ({ expectedLifecycle, expectedStatus, status, statusReason }) => {
      const rows = buildTimelineRows([
        turnStartedEvent({ seq: 0 }),
        permissionGrantLifecycleEvent({
          seq: 1,
          status,
          statusReason,
        }),
      ]);

      expect(collectApprovalRows(rows)).toEqual([
        expect.objectContaining({
          approvalKind: "permission-grant",
          grantScope: null,
          lifecycle: expectedLifecycle,
          status: expectedStatus,
          statusReason,
        }),
      ]);
    },
  );

  it.each([
    {
      expectedAnswers: null,
      expectedLifecycle: "pending",
      expectedStatus: "pending",
      resolution: null,
      status: "pending",
      statusReason: null,
    },
    {
      expectedAnswers: {
        "question-1": {
          selected: ["staging"],
          freeText: "Use staging until QA signs off.",
        },
      },
      expectedLifecycle: "resolving",
      expectedStatus: "pending",
      resolution: {
        kind: "user_answer",
        answers: {
          "question-1": {
            selected: ["staging"],
            freeText: "Use staging until QA signs off.",
          },
        },
      },
      status: "resolving",
      statusReason: null,
    },
    {
      expectedAnswers: {
        "question-1": {
          selected: ["staging"],
          freeText: "Use staging until QA signs off.",
        },
      },
      expectedLifecycle: "answered",
      expectedStatus: "completed",
      resolution: {
        kind: "user_answer",
        answers: {
          "question-1": {
            selected: ["staging"],
            freeText: "Use staging until QA signs off.",
          },
        },
      },
      status: "resolved",
      statusReason: null,
    },
    {
      expectedAnswers: null,
      expectedLifecycle: "interrupted",
      expectedStatus: "interrupted",
      resolution: null,
      status: "interrupted",
      statusReason: "Thread stopped by user request",
    },
  ] satisfies Array<{
    expectedAnswers: UserQuestionPendingInteractionResolution["answers"] | null;
    expectedLifecycle: "pending" | "resolving" | "answered" | "interrupted";
    expectedStatus: "pending" | "completed" | "interrupted";
    resolution: UserQuestionPendingInteractionResolution | null;
    status: "pending" | "resolving" | "resolved" | "interrupted";
    statusReason: string | null;
  }>)(
    "projects user-question $expectedLifecycle lifecycle rows",
    ({
      expectedAnswers,
      expectedLifecycle,
      expectedStatus,
      resolution,
      status,
      statusReason,
    }) => {
      const rows = buildTimelineRows([
        turnStartedEvent({ seq: 0 }),
        userQuestionLifecycleEvent({
          resolution,
          seq: 1,
          status,
          statusReason,
        }),
      ]);

      expect(collectQuestionRows(rows)).toEqual([
        expect.objectContaining({
          answers: expectedAnswers,
          interactionId: "pi-user-question",
          lifecycle: expectedLifecycle,
          questions: [
            expect.objectContaining({
              id: "question-1",
              prompt: "Which deployment target should I use?",
            }),
          ],
          status: expectedStatus,
          statusReason,
          workKind: "question",
        }),
      ]);
    },
  );

  it.each([
    { lateStatus: "pending" },
    { lateStatus: "resolving" },
  ] satisfies Array<{ lateStatus: "pending" | "resolving" }>)(
    "preserves answered user-question rows after late $lateStatus events",
    ({ lateStatus }) => {
      const answers = {
        "question-1": {
          selected: ["staging"],
          freeText: "Use staging until QA signs off.",
        },
      };
      const rows = buildTimelineRows([
        turnStartedEvent({ seq: 0 }),
        userQuestionLifecycleEvent({
          resolution: {
            kind: "user_answer",
            answers,
          },
          seq: 1,
          status: "resolved",
        }),
        userQuestionLifecycleEvent({
          questionPrompt: "Stale duplicate prompt",
          seq: 2,
          status: lateStatus,
          statusReason: "Stale update",
        }),
      ]);

      expect(collectQuestionRows(rows)).toEqual([
        expect.objectContaining({
          answers,
          lifecycle: "answered",
          questions: [
            expect.objectContaining({
              prompt: "Which deployment target should I use?",
            }),
          ],
          sourceSeqEnd: 2,
          status: "completed",
          statusReason: null,
        }),
      ]);
    },
  );

  it.each([
    {
      expectedLifecycle: "interrupted",
      expectedStatus: "interrupted",
      status: "interrupted",
      statusReason: "Thread stopped by user request",
    },
  ] satisfies Array<{
    expectedLifecycle: "interrupted";
    expectedStatus: "interrupted";
    status: "interrupted";
    statusReason: string;
  }>)(
    "preserves terminal user-question $status rows after late resolving events",
    ({ expectedLifecycle, expectedStatus, status, statusReason }) => {
      const rows = buildTimelineRows([
        turnStartedEvent({ seq: 0 }),
        userQuestionLifecycleEvent({
          seq: 1,
          status,
          statusReason,
        }),
        userQuestionLifecycleEvent({
          resolution: {
            kind: "user_answer",
            answers: {
              "question-1": {
                selected: ["production"],
              },
            },
          },
          seq: 2,
          status: "resolving",
        }),
      ]);

      expect(collectQuestionRows(rows)).toEqual([
        expect.objectContaining({
          answers: null,
          lifecycle: expectedLifecycle,
          sourceSeqEnd: 2,
          status: expectedStatus,
          statusReason,
        }),
      ]);
    },
  );

  it.each(["ToolSearch", "TaskCreate", "TaskUpdate", "AskUserQuestion"])(
    "keeps a bare %s tool row: suppression comes from the bridge's presentation, not a name table",
    (tool) => {
      const rows = buildTimelineRows([
        turnStartedEvent({ seq: 0 }),
        toolCallItemEvent({
          seq: 1,
          tool,
          toolArgs: { subject: "Visible without presentation" },
          type: "item/started",
        }),
        toolCallItemEvent({
          result: "ok",
          seq: 2,
          tool,
          toolArgs: { subject: "Visible without presentation" },
          type: "item/completed",
        }),
      ]);
      expect(collectToolRows(rows)).toEqual([
        expect.objectContaining({ status: "completed", toolName: tool }),
      ]);
    },
  );

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

  it("keeps file changes from different turns that reuse the same item id", () => {
    const turn2Started: ThreadEventWithMeta = {
      event: {
        type: "turn/started",
        threadId: "thread-1",
        providerThreadId: "provider-thread-1",
        scope: turnScope("turn-2"),
      },
      meta: { id: "event-2", seq: 2, createdAt: 2 },
    };
    const turn2FileChange: ThreadEventWithMeta = {
      event: {
        type: "item/completed",
        threadId: "thread-1",
        providerThreadId: "provider-thread-1",
        scope: turnScope("turn-2"),
        item: {
          type: "fileChange",
          id: "file-edit-1",
          changes: [
            {
              path: "src/a.ts",
              kind: "update",
              diff: "@@ -1 +1 @@\n-old a\n+turn 2 a",
            },
          ],
          status: "completed",
          approvalStatus: null,
        },
      },
      meta: { id: "event-3", seq: 3, createdAt: 3 },
    };

    const rows = collectFileChangeRows(
      buildTimelineRows([
        turnStartedEvent({ seq: 0 }),
        fileChangeItemEvent({
          changes: [
            {
              path: "src/a.ts",
              kind: "update",
              diff: "@@ -1 +1 @@\n-old a\n+turn 1 a",
            },
          ],
          itemId: "file-edit-1",
          seq: 1,
          type: "item/completed",
        }),
        turn2Started,
        turn2FileChange,
      ]),
    );

    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.id)).size).toBe(2);
    expect(rows.map((row) => row.change.diff)).toEqual([
      "@@ -1 +1 @@\n-old a\n+turn 1 a",
      "@@ -1 +1 @@\n-old a\n+turn 2 a",
    ]);
  });

  it("keeps file-change output separate across turns that reuse the same item id", () => {
    function reusedIdFileChangeEvents(
      turnId: string,
      startSeq: number,
      output: string,
    ): ThreadEventWithMeta[] {
      const scope = turnScope(turnId);
      const change = {
        path: "src/a.ts",
        kind: "update" as const,
        diff: `@@ -1 +1 @@\n-old a\n+${turnId} a`,
      };
      return [
        {
          event: {
            type: "turn/started",
            threadId: "thread-1",
            providerThreadId: "provider-thread-1",
            scope,
          },
          meta: { id: `event-${startSeq}`, seq: startSeq, createdAt: startSeq },
        },
        {
          event: {
            type: "item/started",
            threadId: "thread-1",
            providerThreadId: "provider-thread-1",
            scope,
            item: {
              type: "fileChange",
              id: "file-edit-1",
              changes: [change],
              status: "pending",
              approvalStatus: null,
            },
          },
          meta: {
            id: `event-${startSeq + 1}`,
            seq: startSeq + 1,
            createdAt: startSeq + 1,
          },
        },
        {
          event: {
            type: "item/fileChange/outputDelta",
            threadId: "thread-1",
            providerThreadId: "provider-thread-1",
            scope,
            itemId: "file-edit-1",
            delta: output,
          },
          meta: {
            id: `event-${startSeq + 2}`,
            seq: startSeq + 2,
            createdAt: startSeq + 2,
          },
        },
        {
          event: {
            type: "item/completed",
            threadId: "thread-1",
            providerThreadId: "provider-thread-1",
            scope,
            item: {
              type: "fileChange",
              id: "file-edit-1",
              changes: [change],
              status: "completed",
              approvalStatus: null,
            },
          },
          meta: {
            id: `event-${startSeq + 3}`,
            seq: startSeq + 3,
            createdAt: startSeq + 3,
          },
        },
      ];
    }

    const rows = collectFileChangeRows(
      buildTimelineRows([
        ...reusedIdFileChangeEvents("turn-1", 0, "one-output"),
        ...reusedIdFileChangeEvents("turn-2", 4, "two-output"),
      ]),
    );

    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.stdout)).toEqual(["one-output", "two-output"]);
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

  it("relativizes absolute file-change paths against the workspace root", () => {
    const workspaceRoot = "/Users/dev/worktrees/env_x/bb";
    const rows = collectFileChangeRows(
      buildTimelineRows(
        [
          turnStartedEvent({ seq: 0 }),
          fileChangeItemEvent({
            changes: [
              {
                path: `${workspaceRoot}/src/old.ts`,
                kind: "update",
                movePath: `${workspaceRoot}/src/new.ts`,
                diff: "@@ -1 +1 @@\n-old\n+new",
              },
            ],
            seq: 1,
            type: "item/completed",
          }),
        ],
        "idle",
        workspaceRoot,
      ),
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.change).toMatchObject({
      path: "src/old.ts",
      movePath: "src/new.ts",
    });
  });

  it("leaves file-change paths outside the workspace root untouched", () => {
    const rows = collectFileChangeRows(
      buildTimelineRows(
        [
          turnStartedEvent({ seq: 0 }),
          fileChangeItemEvent({
            changes: [
              {
                path: "/etc/hosts",
                kind: "update",
                diff: "@@ -1 +1 @@\n-old\n+new",
              },
            ],
            seq: 1,
            type: "item/completed",
          }),
        ],
        "idle",
        "/Users/dev/worktrees/env_x/bb",
      ),
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.change.path).toBe("/etc/hosts");
  });
});
