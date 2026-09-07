import {
  encodeClientTurnRequestIdNumber,
  threadScope,
  turnScope,
} from "@bb/domain";
import type {
  ApprovalPendingInteractionResolution,
  ClientTurnRequestId,
  PromptInput,
  ProviderRawEvent,
  ProvisioningTranscriptEntry,
  ResolvedThreadExecutionOptions,
  SystemThreadProvisioningStatus,
  JsonValue,
  ThreadEventItemPresentation,
  ThreadEventRow,
  ThreadEventRowOfType,
  SystemThreadInterruptedReason,
  ThreadEventWarningCategory,
  ThreadTimelinePendingTodos,
  ThreadTurnInitiator,
  TurnRequestTarget,
} from "@bb/domain";
import type { TimelineRow } from "@bb/server-contract";
import type {
  BuildEventProjectionOptions,
  EventProjection,
  EventProjectionMessage,
} from "../src/event-projection-types.js";
import {
  buildThreadTimelineFromEvents,
  formatThreadTimelineText,
} from "../src/index.js";
import { decodeThreadEventRow } from "../src/event-decode.js";
import { EMPTY_ACCEPTED_CLIENT_REQUEST_CONTEXT } from "../src/accepted-client-request-context.js";
import { flattenEventProjectionMessagesDeep } from "../src/event-projection-flatten.js";
import { buildEventProjection } from "../src/build-event-projection.js";
import type { ThreadEventWithMeta } from "../src/build-event-projection.js";

export interface RenderTimelineFixtureArgs {
  events: ThreadEventRow[];
  includeNestedRows?: boolean;
  projectionOptions: Omit<BuildEventProjectionOptions, "threadName"> & {
    threadName?: string;
  };
  verbose?: boolean;
}

export interface RenderedTimelineFixture {
  pendingTodos: ThreadTimelinePendingTodos | null;
  events: ThreadEventRow[];
  messages: EventProjectionMessage[];
  projection: EventProjection;
  rows: TimelineRow[];
  text: string;
  turnRows: Extract<TimelineRow, { kind: "turn" }>[];
}

export interface TimelineEventFactoryDefaults {
  providerThreadId?: string;
  threadId: string;
  turnId?: string;
}

export interface EventFactoryRowOptions {
  createdAt?: number;
  id?: string;
  seq?: number;
  threadId?: string;
}

interface ProviderTurnEventOptions extends EventFactoryRowOptions {
  parentToolCallId?: string;
  providerThreadId?: string;
  turnId?: string;
}

interface DefaultTurnEventOptions extends EventFactoryRowOptions {
  turnId?: string;
}

type ClientTurnRequestedArgs = EventFactoryRowOptions & {
  /** Dispatch-gate provenance; omitted means no gate amended the turn. */
  execution?: ResolvedThreadExecutionOptions;
  initiator?: ThreadTurnInitiator;
  input?: PromptInput[];
  inputGroups?: PromptInput[][];
  requestId?: ClientTurnRequestId;
  requestMethod?: "thread/start" | "turn/start";
  senderThreadId?: string | null;
  source?: "spawn" | "tell";
  target?: TurnRequestTarget;
  text: string;
};

interface InputAcceptedArgs extends ProviderTurnEventOptions {
  clientRequestId: ClientTurnRequestId;
}

interface AssistantDeltaArgs extends ProviderTurnEventOptions {
  delta: string;
  itemId?: string;
  parentToolCallId?: string;
}

interface AssistantCompletedArgs extends ProviderTurnEventOptions {
  itemId?: string;
  parentToolCallId?: string;
  text: string;
}

interface ProviderUserMessageArgs extends ProviderTurnEventOptions {
  itemId?: string;
  text: string;
}

interface ClientTurnRejectedArgs extends EventFactoryRowOptions {
  message?: string;
  reason?: string;
  requestId: ClientTurnRequestId;
}

interface ReasoningCompletedArgs extends ProviderTurnEventOptions {
  itemId?: string;
  text: string;
}

interface ReasoningDeltaArgs extends ProviderTurnEventOptions {
  delta: string;
  itemId?: string;
}

interface ReasoningStartedArgs extends ProviderTurnEventOptions {
  itemId?: string;
}

interface ToolCallCompletedArgs extends ProviderTurnEventOptions {
  arguments?: Record<string, JsonValue>;
  error?: string;
  itemId?: string;
  presentation?: ThreadEventItemPresentation;
  result?: JsonValue;
  status?: "pending" | "completed" | "failed" | "interrupted";
  tool?: string;
}

type ToolCallStartedArgs = ToolCallCompletedArgs;

interface FileReadEventArgs extends ProviderTurnEventOptions {
  itemId?: string;
  path: string;
  cmd?: string;
  presentation?: ThreadEventItemPresentation;
  status?: "pending" | "completed" | "failed" | "interrupted";
}

interface SearchEventArgs extends ProviderTurnEventOptions {
  itemId?: string;
  mode: "content" | "path" | "list";
  query: string;
  path?: string;
  cmd?: string;
  presentation?: ThreadEventItemPresentation;
  status?: "pending" | "completed" | "failed" | "interrupted";
}

interface DelegationEventArgs extends ProviderTurnEventOptions {
  itemId?: string;
  childRef: string;
  label: string;
  background?: boolean;
  summary?: string;
  presentation?: ThreadEventItemPresentation;
  status?: "pending" | "completed" | "failed" | "interrupted";
}

interface PlanStepsEventArgs extends ProviderTurnEventOptions {
  itemId?: string;
  steps: Array<{
    step: string;
    status?: "pending" | "active" | "completed" | "failed";
  }>;
  explanation?: string;
  presentation?: ThreadEventItemPresentation;
  status?: "pending" | "completed" | "failed" | "interrupted";
}

interface ExtensionEventArgs extends ProviderTurnEventOptions {
  itemId?: string;
  kind: `${string}/${string}`;
  payload: JsonValue;
  presentation: ThreadEventItemPresentation;
  status?: "pending" | "completed" | "failed" | "interrupted";
}

interface CommandCompletedArgs extends ProviderTurnEventOptions {
  aggregatedOutput?: string;
  approvalStatus?: "waiting_for_approval" | "denied" | null;
  command: string;
  cwd?: string;
  exitCode?: number;
  itemId?: string;
  presentation?: ThreadEventItemPresentation;
  status?: "pending" | "completed" | "failed" | "interrupted";
}

type CommandStartedArgs = CommandCompletedArgs;

interface CommandOutputDeltaArgs extends ProviderTurnEventOptions {
  delta: string;
  itemId: string;
  reset?: boolean;
}

interface WebSearchCompletedArgs extends ProviderTurnEventOptions {
  itemId?: string;
  queries: string[];
  resultText?: string | null;
}

type WebSearchStartedArgs = WebSearchCompletedArgs;

interface WebFetchCompletedArgs extends ProviderTurnEventOptions {
  itemId?: string;
  pattern?: string | null;
  prompt?: string | null;
  resultText?: string | null;
  url: string;
}

type WebFetchStartedArgs = WebFetchCompletedArgs;

interface FileChangeCompletedArgs extends ProviderTurnEventOptions {
  approvalStatus?: "waiting_for_approval" | "denied" | null;
  changes: Array<{
    diff?: string;
    kind: "add" | "delete" | "update";
    path: string;
  }>;
  itemId?: string;
  status?: "pending" | "completed" | "failed" | "interrupted";
}

type FileChangeStartedArgs = FileChangeCompletedArgs;

interface ContextCompactionArgs extends ProviderTurnEventOptions {
  itemId?: string;
}

interface TurnPlanUpdatedArgs extends ProviderTurnEventOptions {
  plan: Array<{
    status: "pending" | "active" | "completed";
    step: string;
  }>;
}

interface ThreadProvisioningArgs extends EventFactoryRowOptions {
  entries: ProvisioningTranscriptEntry[];
  environmentId?: string;
  provisioningId?: string;
  status: SystemThreadProvisioningStatus;
}

interface SystemErrorArgs extends EventFactoryRowOptions {
  code?: string;
  detail?: string;
  message: string;
}

interface ProviderErrorArgs extends ProviderTurnEventOptions {
  detail?: string;
  message: string;
  willRetry?: boolean;
}

interface ProviderWarningArgs extends ProviderTurnEventOptions {
  category?: ThreadEventWarningCategory;
  details?: string;
  summary?: string;
}

interface SystemOperationArgs extends EventFactoryRowOptions {
  message: string;
  metadata?: Record<string, JsonValue>;
  operation?: string;
  operationId?: string;
  status?: string;
  turnId?: string;
}

interface SystemThreadInterruptedArgs extends EventFactoryRowOptions {
  cause?: "host-connection-lost";
  reason?: SystemThreadInterruptedReason;
}

interface PermissionGrantLifecycleArgs extends DefaultTurnEventOptions {
  interactionId?: string;
  itemId?: string;
  providerId?: string;
  providerRequestId?: string;
  resolution?: ApprovalPendingInteractionResolution | null;
  status?: "pending" | "resolving" | "resolved" | "interrupted";
  statusReason?: string | null;
  toolName?: string;
}

interface LegacyUserMessageArgs extends EventFactoryRowOptions {
  text: string;
  turnId?: string;
}

interface ProviderUnhandledArgs extends ProviderTurnEventOptions {
  providerId?: string;
  rawEvent?: ProviderRawEvent;
  rawType?: string;
}

interface WarningArgs extends EventFactoryRowOptions {
  category?: ThreadEventWarningCategory;
  details?: string;
  summary?: string;
}

export interface TimelineEventFactory {
  assistantDelta(
    args: AssistantDeltaArgs,
  ): ThreadEventRowOfType<"item/agentMessage/delta">;
  assistantCompleted(
    args: AssistantCompletedArgs,
  ): ThreadEventRowOfType<"item/completed">;
  clientTurnRequested(
    args: ClientTurnRequestedArgs,
  ): ThreadEventRowOfType<"client/turn/requested">;
  clientTurnRejected(
    args: ClientTurnRejectedArgs,
  ): ThreadEventRowOfType<"client/turn/rejected">;
  commandCompleted(
    args: CommandCompletedArgs,
  ): ThreadEventRowOfType<"item/completed">;
  commandOutputDelta(
    args: CommandOutputDeltaArgs,
  ): ThreadEventRowOfType<"item/commandExecution/outputDelta">;
  commandStarted(
    args: CommandStartedArgs,
  ): ThreadEventRowOfType<"item/started">;
  contextCompactionCompleted(
    args?: ContextCompactionArgs,
  ): ThreadEventRowOfType<"item/completed">;
  contextCompactionStarted(
    args?: ContextCompactionArgs,
  ): ThreadEventRowOfType<"item/started">;
  fileChangeCompleted(
    args: FileChangeCompletedArgs,
  ): ThreadEventRowOfType<"item/completed">;
  fileChangeStarted(
    args: FileChangeStartedArgs,
  ): ThreadEventRowOfType<"item/started">;
  inputAccepted(
    args: InputAcceptedArgs,
  ): ThreadEventRowOfType<"turn/input/accepted">;
  legacyUserMessage(
    args: LegacyUserMessageArgs,
  ): ThreadEventRowOfType<"system/manager/user_message">;
  permissionGrantLifecycle(
    args?: PermissionGrantLifecycleArgs,
  ): ThreadEventRowOfType<"system/interaction/lifecycle">;
  providerError(
    args: ProviderErrorArgs,
  ): ThreadEventRowOfType<"provider/error">;
  providerUnhandled(
    args?: ProviderUnhandledArgs,
  ): ThreadEventRowOfType<"provider/unhandled">;
  providerUserMessage(
    args: ProviderUserMessageArgs,
  ): ThreadEventRowOfType<"item/completed">;
  providerWarning(
    args?: ProviderWarningArgs,
  ): ThreadEventRowOfType<"provider/warning">;
  reasoningCompleted(
    args: ReasoningCompletedArgs,
  ): ThreadEventRowOfType<"item/completed">;
  reasoningDelta(
    args: ReasoningDeltaArgs,
  ): ThreadEventRowOfType<"item/reasoning/textDelta">;
  reasoningStarted(
    args?: ReasoningStartedArgs,
  ): ThreadEventRowOfType<"item/started">;
  systemError(args: SystemErrorArgs): ThreadEventRowOfType<"system/error">;
  systemOperation(
    args: SystemOperationArgs,
  ): ThreadEventRowOfType<"system/operation">;
  systemThreadInterrupted(
    args?: SystemThreadInterruptedArgs,
  ): ThreadEventRowOfType<"system/thread/interrupted">;
  threadProvisioning(
    args: ThreadProvisioningArgs,
  ): ThreadEventRowOfType<"system/thread-provisioning">;
  toolCallCompleted(
    args: ToolCallCompletedArgs,
  ): ThreadEventRowOfType<"item/completed">;
  delegationStarted(
    args: DelegationEventArgs,
  ): ThreadEventRowOfType<"item/started">;
  delegationCompleted(
    args: DelegationEventArgs,
  ): ThreadEventRowOfType<"item/completed">;
  toolCallStarted(
    args: ToolCallStartedArgs,
  ): ThreadEventRowOfType<"item/started">;
  fileReadStarted(
    args: FileReadEventArgs,
  ): ThreadEventRowOfType<"item/started">;
  fileReadCompleted(
    args: FileReadEventArgs,
  ): ThreadEventRowOfType<"item/completed">;
  searchStarted(args: SearchEventArgs): ThreadEventRowOfType<"item/started">;
  searchCompleted(
    args: SearchEventArgs,
  ): ThreadEventRowOfType<"item/completed">;
  planStepsStarted(
    args: PlanStepsEventArgs,
  ): ThreadEventRowOfType<"item/started">;
  planStepsCompleted(
    args: PlanStepsEventArgs,
  ): ThreadEventRowOfType<"item/completed">;
  extensionStarted(
    args: ExtensionEventArgs,
  ): ThreadEventRowOfType<"item/started">;
  extensionCompleted(
    args: ExtensionEventArgs,
  ): ThreadEventRowOfType<"item/completed">;
  threadCompacted(
    args?: ProviderTurnEventOptions,
  ): ThreadEventRowOfType<"thread/compacted">;
  threadContextCleared(
    args?: ProviderTurnEventOptions,
  ): ThreadEventRowOfType<"thread/context/cleared">;
  turnCompleted(
    args?: ProviderTurnEventOptions & {
      status?: "completed" | "failed" | "interrupted";
    },
  ): ThreadEventRowOfType<"turn/completed">;
  turnPlanUpdated(
    args: TurnPlanUpdatedArgs,
  ): ThreadEventRowOfType<"turn/plan/updated">;
  turnStarted(
    args?: ProviderTurnEventOptions,
  ): ThreadEventRowOfType<"turn/started">;
  webSearchCompleted(
    args: WebSearchCompletedArgs,
  ): ThreadEventRowOfType<"item/completed">;
  webSearchStarted(
    args: WebSearchStartedArgs,
  ): ThreadEventRowOfType<"item/started">;
  webFetchCompleted(
    args: WebFetchCompletedArgs,
  ): ThreadEventRowOfType<"item/completed">;
  webFetchStarted(
    args: WebFetchStartedArgs,
  ): ThreadEventRowOfType<"item/started">;
  warning(args?: WarningArgs): ThreadEventRowOfType<"provider/warning">;
}

export function fromRows(rows: ThreadEventRow[]): ThreadEventWithMeta[] {
  return rows.map((row) =>
    decodeThreadEventRow(withExplicitApprovalStatus(row)),
  );
}

function withExplicitApprovalStatus(row: ThreadEventRow): ThreadEventRow {
  if (row.type !== "item/started" && row.type !== "item/completed") {
    return row;
  }

  const item = row.data.item;
  if (item.type !== "commandExecution" && item.type !== "fileChange") {
    return row;
  }
  if (item.approvalStatus !== undefined) {
    return row;
  }

  return {
    ...row,
    data: {
      ...row.data,
      item: {
        ...item,
        approvalStatus: null,
      },
    },
  };
}

const defaultExecution: ResolvedThreadExecutionOptions = {
  model: "gpt-5",
  serviceTier: "default",
  reasoningLevel: "medium",
  permissionMode: "full",
  source: "client/turn/requested",
};

function clientRequestIdForSequence(sequence: number): ClientTurnRequestId {
  return encodeClientTurnRequestIdNumber({ value: sequence });
}

export function createTimelineEventFactory(
  defaults: TimelineEventFactoryDefaults,
): TimelineEventFactory {
  let nextSeq = 1;

  function nextRowBase(
    typePrefix: string,
    options: EventFactoryRowOptions | undefined,
  ) {
    const seq = options?.seq ?? nextSeq;
    nextSeq = Math.max(nextSeq, seq + 1);
    return {
      id: options?.id ?? `evt-${typePrefix}-${seq}`,
      threadId: options?.threadId ?? defaults.threadId,
      seq,
      createdAt: options?.createdAt ?? seq,
    };
  }

  function nextThreadScopedRowBase(
    typePrefix: string,
    options: EventFactoryRowOptions | undefined,
  ) {
    return {
      ...nextRowBase(typePrefix, options),
      scope: threadScope(),
    };
  }

  function defaultTurnId(): string {
    return defaults.turnId ?? "turn-1";
  }

  function providerTurnId(args: ProviderTurnEventOptions | undefined): string {
    return args?.turnId ?? defaultTurnId();
  }

  function nextProviderTurnScopedRowBase(
    typePrefix: string,
    options: ProviderTurnEventOptions | undefined,
  ) {
    return {
      ...nextRowBase(typePrefix, options),
      scope: turnScope(providerTurnId(options)),
    };
  }

  function nextDefaultTurnScopedRowBase(
    typePrefix: string,
    options: DefaultTurnEventOptions | undefined,
  ) {
    return {
      ...nextRowBase(typePrefix, options),
      scope: turnScope(options?.turnId ?? defaultTurnId()),
    };
  }

  function providerFields(args: ProviderTurnEventOptions | undefined) {
    return {
      providerThreadId:
        args?.providerThreadId ??
        defaults.providerThreadId ??
        "provider-thread-1",
      turnId: providerTurnId(args),
    };
  }

  return {
    assistantDelta(args) {
      const base = nextProviderTurnScopedRowBase("assistant-delta", args);
      return {
        ...base,
        type: "item/agentMessage/delta",
        data: {
          ...providerFields(args),
          itemId: args.itemId ?? `assistant-${base.seq}`,
          delta: args.delta,
          ...(args.parentToolCallId
            ? { parentToolCallId: args.parentToolCallId }
            : {}),
        },
      };
    },
    assistantCompleted(args) {
      const base = nextProviderTurnScopedRowBase("assistant-completed", args);
      return {
        ...base,
        type: "item/completed",
        data: {
          ...providerFields(args),
          item: {
            type: "agentMessage",
            id: args.itemId ?? `assistant-${base.seq}`,
            text: args.text,
            ...(args.parentToolCallId
              ? { parentToolCallId: args.parentToolCallId }
              : {}),
          },
        },
      };
    },
    providerUserMessage(args) {
      const base = nextProviderTurnScopedRowBase("provider-user-message", args);
      return {
        ...base,
        type: "item/completed",
        data: {
          ...providerFields(args),
          item: {
            type: "userMessage",
            id: args.itemId ?? `provider-input-${base.seq}`,
            content: [{ type: "text", text: args.text }],
            ...(args.parentToolCallId
              ? { parentToolCallId: args.parentToolCallId }
              : {}),
          },
        },
      };
    },
    clientTurnRequested(args) {
      const base = nextThreadScopedRowBase("client-turn-requested", args);
      const initiator = args.initiator ?? "user";
      const senderThreadId =
        args.senderThreadId !== undefined
          ? args.senderThreadId
          : initiator === "agent"
            ? "thr_sender"
            : null;
      return {
        ...base,
        type: "client/turn/requested",
        data: {
          direction: "outbound",
          requestId: args.requestId ?? clientRequestIdForSequence(base.seq),
          source: args.source ?? "tell",
          initiator,
          senderThreadId,
          input: args.input ?? [
            { type: "text", text: args.text, mentions: [] },
          ],
          ...(args.inputGroups !== undefined
            ? { inputGroups: args.inputGroups }
            : {}),
          target: args.target ?? { kind: "new-turn" },
          request: {
            method: args.requestMethod ?? "turn/start",
            params: {},
          },
          execution: args.execution ?? defaultExecution,
        },
      };
    },
    clientTurnRejected(args) {
      const base = nextThreadScopedRowBase("client-turn-rejected", args);
      return {
        ...base,
        type: "client/turn/rejected",
        data: {
          requestId: args.requestId,
          reason: args.reason ?? "command_failed",
          message: args.message ?? "The command failed",
        },
      };
    },
    commandCompleted(args) {
      const base = nextProviderTurnScopedRowBase("command-completed", args);
      return {
        ...base,
        type: "item/completed",
        data: {
          ...providerFields(args),
          item: {
            type: "commandExecution",
            id: args.itemId ?? `command-${base.seq}`,
            command: args.command,
            cwd: args.cwd ?? "/repo",
            aggregatedOutput: args.aggregatedOutput,
            exitCode: args.exitCode,
            status: args.status ?? "completed",
            approvalStatus: args.approvalStatus ?? null,
            ...(args.presentation ? { presentation: args.presentation } : {}),
          },
        },
      };
    },
    commandOutputDelta(args) {
      const base = nextProviderTurnScopedRowBase("command-output-delta", args);
      return {
        ...base,
        type: "item/commandExecution/outputDelta",
        data: {
          ...providerFields(args),
          itemId: args.itemId,
          delta: args.delta,
          ...(args.reset ? { reset: true } : {}),
        },
      };
    },
    commandStarted(args) {
      const base = nextProviderTurnScopedRowBase("command-started", args);
      return {
        ...base,
        type: "item/started",
        data: {
          ...providerFields(args),
          item: {
            type: "commandExecution",
            id: args.itemId ?? `command-${base.seq}`,
            command: args.command,
            cwd: args.cwd ?? "/repo",
            aggregatedOutput: args.aggregatedOutput,
            exitCode: args.exitCode,
            status: args.status ?? "pending",
            approvalStatus: args.approvalStatus ?? null,
            ...(args.presentation ? { presentation: args.presentation } : {}),
          },
        },
      };
    },
    contextCompactionCompleted(args = {}) {
      const base = nextProviderTurnScopedRowBase(
        "context-compaction-completed",
        args,
      );
      return {
        ...base,
        type: "item/completed",
        data: {
          ...providerFields(args),
          item: {
            type: "contextCompaction",
            id: args.itemId ?? "compact-1",
          },
        },
      };
    },
    contextCompactionStarted(args = {}) {
      const base = nextProviderTurnScopedRowBase(
        "context-compaction-started",
        args,
      );
      return {
        ...base,
        type: "item/started",
        data: {
          ...providerFields(args),
          item: {
            type: "contextCompaction",
            id: args.itemId ?? "compact-1",
          },
        },
      };
    },
    fileChangeCompleted(args) {
      const base = nextProviderTurnScopedRowBase("file-change-completed", args);
      return {
        ...base,
        type: "item/completed",
        data: {
          ...providerFields(args),
          item: {
            type: "fileChange",
            id: args.itemId ?? `file-change-${base.seq}`,
            changes: args.changes,
            status: args.status ?? "completed",
            approvalStatus: args.approvalStatus ?? null,
          },
        },
      };
    },
    fileChangeStarted(args) {
      const base = nextProviderTurnScopedRowBase("file-change-started", args);
      return {
        ...base,
        type: "item/started",
        data: {
          ...providerFields(args),
          item: {
            type: "fileChange",
            id: args.itemId ?? `file-change-${base.seq}`,
            changes: args.changes,
            status: args.status ?? "pending",
            approvalStatus: args.approvalStatus ?? null,
          },
        },
      };
    },
    inputAccepted(args) {
      const base = nextProviderTurnScopedRowBase("input-accepted", args);
      return {
        ...base,
        type: "turn/input/accepted",
        data: {
          ...providerFields(args),
          clientRequestId: args.clientRequestId,
        },
      };
    },
    legacyUserMessage(args) {
      const base = {
        ...nextRowBase("legacy-user-message", args),
        scope: turnScope(args.turnId ?? defaultTurnId()),
      };
      return {
        ...base,
        type: "system/manager/user_message",
        data: {
          text: args.text,
          turnId: args.turnId ?? defaultTurnId(),
        },
      };
    },
    permissionGrantLifecycle(args = {}) {
      const base = nextDefaultTurnScopedRowBase(
        "permission-grant-lifecycle",
        args,
      );
      return {
        ...base,
        type: "system/interaction/lifecycle",
        data: {
          interaction: {
            id: args.interactionId ?? "pi_123",
            status: args.status ?? "pending",
            statusReason: args.statusReason ?? null,
            origin: {
              kind: "provider",
              providerId: args.providerId ?? "codex",
              providerRequestId: args.providerRequestId ?? "request-123",
            },
            payload: {
              kind: "approval",
              reason: null,
              subject: {
                kind: "permission_grant",
                itemId: args.itemId ?? "item_123",
                toolName: args.toolName ?? "Bash",
                permissions: {
                  network: null,
                  fileSystem: {
                    read: ["/tmp/project"],
                    write: [],
                  },
                },
              },
            },
            resolution: args.resolution ?? null,
          },
        },
      };
    },
    providerError(args) {
      const base = nextProviderTurnScopedRowBase("provider-error", args);
      return {
        ...base,
        type: "provider/error",
        data: {
          ...providerFields(args),
          message: args.message,
          detail: args.detail,
          willRetry: args.willRetry,
        },
      };
    },
    providerWarning(args = {}) {
      const base = nextProviderTurnScopedRowBase("provider-warning", args);
      return {
        ...base,
        type: "provider/warning",
        data: {
          ...providerFields(args),
          category: args.category ?? "general",
          summary: args.summary,
          details: args.details,
        },
      };
    },
    providerUnhandled(args = {}) {
      const base = nextProviderTurnScopedRowBase("provider-unhandled", args);
      return {
        ...base,
        type: "provider/unhandled",
        data: {
          ...providerFields(args),
          providerId: args.providerId ?? "codex",
          rawType: args.rawType ?? "session.updated",
          rawEvent: args.rawEvent ?? {
            jsonrpc: "2.0",
            method: "session.updated",
          },
        },
      };
    },
    systemError(args) {
      const base = nextThreadScopedRowBase("system-error", args);
      return {
        ...base,
        type: "system/error",
        data: {
          code: args.code,
          message: args.message,
          detail: args.detail,
        },
      };
    },
    systemOperation(args) {
      const base =
        args.turnId !== undefined
          ? {
              ...nextRowBase("system-operation", args),
              scope: turnScope(args.turnId),
            }
          : nextThreadScopedRowBase("system-operation", args);
      return {
        ...base,
        type: "system/operation",
        data: {
          operation: args.operation ?? "ownership_change",
          operationId: args.operationId ?? "op-test",
          status: args.status ?? "running",
          message: args.message,
          ...(args.metadata ? { metadata: args.metadata } : {}),
        },
      };
    },
    systemThreadInterrupted(args = {}) {
      const base = nextThreadScopedRowBase("system-thread-interrupted", args);
      return {
        ...base,
        type: "system/thread/interrupted",
        data: {
          reason: args.reason ?? "manual-stop",
          ...(args.cause ? { cause: args.cause } : {}),
        },
      };
    },
    threadProvisioning(args) {
      const base = nextThreadScopedRowBase("thread-provisioning", args);
      return {
        ...base,
        type: "system/thread-provisioning",
        data: {
          provisioningId: args.provisioningId ?? "tpv-test",
          status: args.status,
          environmentId: args.environmentId ?? "env-1",
          entries: args.entries,
        },
      };
    },
    toolCallCompleted(args) {
      const base = nextProviderTurnScopedRowBase("tool-call-completed", args);
      return {
        ...base,
        type: "item/completed",
        data: {
          ...providerFields(args),
          item: {
            type: "toolCall",
            id: args.itemId ?? `tool-${base.seq}`,
            tool: args.tool ?? "exec_command",
            arguments: args.arguments,
            result: args.result,
            error: args.error,
            status: args.status ?? "completed",
            ...(args.presentation === undefined
              ? {}
              : { presentation: args.presentation }),
          },
        },
      };
    },
    delegationStarted(args) {
      const base = nextProviderTurnScopedRowBase("delegation-started", args);
      return {
        ...base,
        type: "item/started",
        data: {
          ...providerFields(args),
          item: {
            type: "delegation",
            id: args.itemId ?? `delegation-${base.seq}`,
            childRef: args.childRef,
            label: args.label,
            status: args.status ?? "pending",
            background: args.background ?? false,
            ...(args.summary === undefined ? {} : { summary: args.summary }),
            ...(args.presentation === undefined
              ? {}
              : { presentation: args.presentation }),
          },
        },
      };
    },
    delegationCompleted(args) {
      const base = nextProviderTurnScopedRowBase("delegation-completed", args);
      return {
        ...base,
        type: "item/completed",
        data: {
          ...providerFields(args),
          item: {
            type: "delegation",
            id: args.itemId ?? `delegation-${base.seq}`,
            childRef: args.childRef,
            label: args.label,
            status: args.status ?? "completed",
            background: args.background ?? false,
            ...(args.summary === undefined ? {} : { summary: args.summary }),
            ...(args.presentation === undefined
              ? {}
              : { presentation: args.presentation }),
          },
        },
      };
    },
    toolCallStarted(args) {
      const base = nextProviderTurnScopedRowBase("tool-call-started", args);
      return {
        ...base,
        type: "item/started",
        data: {
          ...providerFields(args),
          item: {
            type: "toolCall",
            id: args.itemId ?? `tool-${base.seq}`,
            tool: args.tool ?? "exec_command",
            arguments: args.arguments,
            result: args.result,
            error: args.error,
            status: args.status ?? "pending",
            ...(args.presentation === undefined
              ? {}
              : { presentation: args.presentation }),
          },
        },
      };
    },
    fileReadStarted(args) {
      const base = nextProviderTurnScopedRowBase("file-read-started", args);
      return {
        ...base,
        type: "item/started",
        data: {
          ...providerFields(args),
          item: {
            type: "fileRead",
            id: args.itemId ?? `file-read-${base.seq}`,
            path: args.path,
            ...(args.cmd === undefined ? {} : { cmd: args.cmd }),
            status: args.status ?? "pending",
            ...(args.presentation === undefined
              ? {}
              : { presentation: args.presentation }),
          },
        },
      };
    },
    fileReadCompleted(args) {
      const base = nextProviderTurnScopedRowBase("file-read-completed", args);
      return {
        ...base,
        type: "item/completed",
        data: {
          ...providerFields(args),
          item: {
            type: "fileRead",
            id: args.itemId ?? `file-read-${base.seq}`,
            path: args.path,
            ...(args.cmd === undefined ? {} : { cmd: args.cmd }),
            status: args.status ?? "completed",
            ...(args.presentation === undefined
              ? {}
              : { presentation: args.presentation }),
          },
        },
      };
    },
    searchStarted(args) {
      const base = nextProviderTurnScopedRowBase("search-started", args);
      return {
        ...base,
        type: "item/started",
        data: {
          ...providerFields(args),
          item: {
            type: "search",
            id: args.itemId ?? `search-${base.seq}`,
            mode: args.mode,
            query: args.query,
            ...(args.path === undefined ? {} : { path: args.path }),
            ...(args.cmd === undefined ? {} : { cmd: args.cmd }),
            status: args.status ?? "pending",
            ...(args.presentation === undefined
              ? {}
              : { presentation: args.presentation }),
          },
        },
      };
    },
    searchCompleted(args) {
      const base = nextProviderTurnScopedRowBase("search-completed", args);
      return {
        ...base,
        type: "item/completed",
        data: {
          ...providerFields(args),
          item: {
            type: "search",
            id: args.itemId ?? `search-${base.seq}`,
            mode: args.mode,
            query: args.query,
            ...(args.path === undefined ? {} : { path: args.path }),
            ...(args.cmd === undefined ? {} : { cmd: args.cmd }),
            status: args.status ?? "completed",
            ...(args.presentation === undefined
              ? {}
              : { presentation: args.presentation }),
          },
        },
      };
    },
    planStepsStarted(args) {
      const base = nextProviderTurnScopedRowBase("plan-steps-started", args);
      return {
        ...base,
        type: "item/started",
        data: {
          ...providerFields(args),
          item: {
            type: "planSteps",
            id: args.itemId ?? `plan-steps-${base.seq}`,
            steps: args.steps,
            ...(args.explanation === undefined
              ? {}
              : { explanation: args.explanation }),
            status: args.status ?? "pending",
            ...(args.presentation === undefined
              ? {}
              : { presentation: args.presentation }),
          },
        },
      };
    },
    planStepsCompleted(args) {
      const base = nextProviderTurnScopedRowBase("plan-steps-completed", args);
      return {
        ...base,
        type: "item/completed",
        data: {
          ...providerFields(args),
          item: {
            type: "planSteps",
            id: args.itemId ?? `plan-steps-${base.seq}`,
            steps: args.steps,
            ...(args.explanation === undefined
              ? {}
              : { explanation: args.explanation }),
            status: args.status ?? "completed",
            ...(args.presentation === undefined
              ? {}
              : { presentation: args.presentation }),
          },
        },
      };
    },
    extensionStarted(args) {
      const base = nextProviderTurnScopedRowBase("extension-started", args);
      return {
        ...base,
        type: "item/started",
        data: {
          ...providerFields(args),
          item: {
            type: "extension",
            id: args.itemId ?? `extension-${base.seq}`,
            kind: args.kind,
            payload: args.payload,
            status: args.status ?? "pending",
            presentation: args.presentation,
          },
        },
      };
    },
    extensionCompleted(args) {
      const base = nextProviderTurnScopedRowBase("extension-completed", args);
      return {
        ...base,
        type: "item/completed",
        data: {
          ...providerFields(args),
          item: {
            type: "extension",
            id: args.itemId ?? `extension-${base.seq}`,
            kind: args.kind,
            payload: args.payload,
            status: args.status ?? "completed",
            presentation: args.presentation,
          },
        },
      };
    },
    threadCompacted(args = {}) {
      const base = nextProviderTurnScopedRowBase("thread-compacted", args);
      return {
        ...base,
        type: "thread/compacted",
        data: {
          ...providerFields(args),
          threadId: args.threadId ?? defaults.threadId,
        },
      };
    },
    threadContextCleared(args = {}) {
      const base = nextProviderTurnScopedRowBase(
        "thread-context-cleared",
        args,
      );
      return {
        ...base,
        type: "thread/context/cleared",
        data: {
          ...providerFields(args),
          threadId: args.threadId ?? defaults.threadId,
        },
      };
    },
    turnCompleted(args) {
      const base = nextProviderTurnScopedRowBase("turn-completed", args);
      return {
        ...base,
        type: "turn/completed",
        data: {
          ...providerFields(args),
          status: args?.status ?? "completed",
        },
      };
    },
    turnPlanUpdated(args) {
      const base = nextProviderTurnScopedRowBase("turn-plan-updated", args);
      return {
        ...base,
        type: "turn/plan/updated",
        data: {
          ...providerFields(args),
          plan: args.plan,
        },
      };
    },
    turnStarted(args) {
      const base = nextProviderTurnScopedRowBase("turn-started", args);
      return {
        ...base,
        type: "turn/started",
        data: {
          ...providerFields(args),
          ...(args?.parentToolCallId
            ? { parentToolCallId: args.parentToolCallId }
            : {}),
        },
      };
    },
    reasoningCompleted(args) {
      const base = nextProviderTurnScopedRowBase("reasoning-completed", args);
      return {
        ...base,
        type: "item/completed",
        data: {
          ...providerFields(args),
          item: {
            type: "reasoning",
            id: args.itemId ?? `reasoning-${base.seq}`,
            summary: [],
            content: [args.text],
            ...(args.parentToolCallId
              ? { parentToolCallId: args.parentToolCallId }
              : {}),
          },
        },
      };
    },
    reasoningDelta(args) {
      const base = nextProviderTurnScopedRowBase("reasoning-delta", args);
      return {
        ...base,
        type: "item/reasoning/textDelta",
        data: {
          ...providerFields(args),
          itemId: args.itemId ?? `reasoning-${base.seq}`,
          delta: args.delta,
          ...(args.parentToolCallId
            ? { parentToolCallId: args.parentToolCallId }
            : {}),
        },
      };
    },
    reasoningStarted(args = {}) {
      const base = nextProviderTurnScopedRowBase("reasoning-started", args);
      return {
        ...base,
        type: "item/started",
        data: {
          ...providerFields(args),
          item: {
            type: "reasoning",
            id: args.itemId ?? `reasoning-${base.seq}`,
            summary: [],
            content: [],
            ...(args.parentToolCallId
              ? { parentToolCallId: args.parentToolCallId }
              : {}),
          },
        },
      };
    },
    webSearchStarted(args) {
      const base = nextProviderTurnScopedRowBase("web-search-started", args);
      return {
        ...base,
        type: "item/started",
        data: {
          ...providerFields(args),
          item: {
            type: "webSearch",
            id: args.itemId ?? `web-${base.seq}`,
            queries: args.queries,
            resultText: args.resultText ?? null,
          },
        },
      };
    },
    webSearchCompleted(args) {
      const base = nextProviderTurnScopedRowBase("web-search-completed", args);
      return {
        ...base,
        type: "item/completed",
        data: {
          ...providerFields(args),
          item: {
            type: "webSearch",
            id: args.itemId ?? `web-${base.seq}`,
            queries: args.queries,
            resultText: args.resultText ?? null,
          },
        },
      };
    },
    webFetchStarted(args) {
      const base = nextProviderTurnScopedRowBase("web-fetch-started", args);
      return {
        ...base,
        type: "item/started",
        data: {
          ...providerFields(args),
          item: {
            type: "webFetch",
            id: args.itemId ?? `web-fetch-${base.seq}`,
            url: args.url,
            prompt: args.prompt ?? null,
            pattern: args.pattern ?? null,
            resultText: args.resultText ?? null,
          },
        },
      };
    },
    webFetchCompleted(args) {
      const base = nextProviderTurnScopedRowBase("web-fetch-completed", args);
      return {
        ...base,
        type: "item/completed",
        data: {
          ...providerFields(args),
          item: {
            type: "webFetch",
            id: args.itemId ?? `web-fetch-${base.seq}`,
            url: args.url,
            prompt: args.prompt ?? null,
            pattern: args.pattern ?? null,
            resultText: args.resultText ?? null,
          },
        },
      };
    },
    warning(args = {}) {
      const base = nextThreadScopedRowBase("warning", args);
      return {
        ...base,
        type: "provider/warning",
        data: {
          providerThreadId: defaults.providerThreadId ?? "provider-thread-1",
          category: args.category ?? "general",
          summary: args.summary,
          details: args.details,
        },
      };
    },
  };
}

export function renderTimelineFixture(
  args: RenderTimelineFixtureArgs,
): RenderedTimelineFixture {
  const decodedEvents = args.events.map((row) => decodeThreadEventRow(row));
  const includeNestedRows = args.includeNestedRows ?? true;
  const projection = buildEventProjection(decodedEvents, {
    ...args.projectionOptions,
    threadName: args.projectionOptions.threadName ?? "",
    turnMessageDetail: includeNestedRows
      ? "full"
      : args.projectionOptions.turnMessageDetail,
  });
  const commonProjectionOptions = {
    includeProviderUnhandledOperations:
      args.projectionOptions.includeProviderUnhandledOperations ?? false,
    isLatestPage: true,
    threadStatus: args.projectionOptions.threadStatus ?? "idle",
    threadName: args.projectionOptions.threadName ?? "",
    workspaceRoot: null,
  };
  const timeline = buildThreadTimelineFromEvents({
    acceptedClientRequestContext: EMPTY_ACCEPTED_CLIENT_REQUEST_CONTEXT,
    contextWindowEvents: [],
    events: decodedEvents,
    options: {
      ...commonProjectionOptions,
      includeNestedRows,
      turnMessageDetail: includeNestedRows
        ? "full"
        : args.projectionOptions.turnMessageDetail,
    },
  });
  const rows = timeline.rows;
  const messages = flattenEventProjectionMessagesDeep(projection);
  const text = formatThreadTimelineText(rows, {
    color: false,
    verbose: args.verbose ?? true,
  });
  const turnRows = rows.filter(
    (row): row is Extract<TimelineRow, { kind: "turn" }> => row.kind === "turn",
  );

  return {
    events: args.events,
    messages,
    pendingTodos: timeline.pendingTodos,
    projection,
    rows,
    text,
    turnRows,
  };
}

export function messageKinds(
  messages: readonly EventProjectionMessage[],
): string[] {
  return messages.map((message) => message.kind);
}
