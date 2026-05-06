import {
  encodeClientTurnRequestIdNumber,
  threadScope,
  turnScope,
} from "@bb/domain";
import type {
  ClientTurnRequestId,
  PromptInput,
  ProviderRawEvent,
  ProvisioningTranscriptEntry,
  ResolvedThreadExecutionOptions,
  SystemThreadProvisioningStatus,
  JsonValue,
  ThreadEventRow,
  ThreadEventRowOfType,
  ThreadEventUserContent,
  ThreadEventWarningCategory,
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
  decodeThreadEventRow,
  formatThreadTimelineText,
} from "../src/index.js";
import { flattenEventProjectionMessagesDeep } from "../src/event-projection-flatten.js";
import { buildEventProjection } from "../src/build-event-projection.js";
import type { ThreadEventWithMeta } from "../src/build-event-projection.js";

export interface RenderTimelineFixtureArgs {
  events: ThreadEventRow[];
  includeNestedRows?: boolean;
  projectionOptions: BuildEventProjectionOptions;
  verbose?: boolean;
}

export interface RenderedTimelineFixture {
  events: ThreadEventRow[];
  messages: EventProjectionMessage[];
  projection: EventProjection;
  rows: TimelineRow[];
  text: string;
  turnRows: Extract<TimelineRow, { kind: "turn" }>[];
}

export interface RenderTimelinePrefixesArgs extends RenderTimelineFixtureArgs {
  startAt?: number;
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
  providerThreadId?: string;
  turnId?: string;
}

interface DefaultTurnEventOptions extends EventFactoryRowOptions {
  turnId?: string;
}

type ClientTurnRequestedArgs = EventFactoryRowOptions & {
  execution?: ResolvedThreadExecutionOptions;
  initiator?: ThreadTurnInitiator;
  input?: PromptInput[];
  requestId?: ClientTurnRequestId;
  requestMethod?: "thread/start" | "turn/start";
  source?: "spawn" | "tell";
  target?: TurnRequestTarget;
  text: string;
};

type ClientThreadStartArgs = ClientTurnRequestedArgs;

interface InputAcceptedArgs extends ProviderTurnEventOptions {
  clientRequestId: ClientTurnRequestId;
}

interface ProviderUserMessageArgs extends ProviderTurnEventOptions {
  content?: ThreadEventUserContent[];
  itemId?: string;
  text: string;
}

interface AssistantDeltaArgs extends ProviderTurnEventOptions {
  delta: string;
  itemId?: string;
}

interface AssistantCompletedArgs extends ProviderTurnEventOptions {
  itemId?: string;
  text: string;
}

interface ReasoningCompletedArgs extends ProviderTurnEventOptions {
  itemId?: string;
  text: string;
}

interface ReasoningDeltaArgs extends ProviderTurnEventOptions {
  delta: string;
  itemId?: string;
}

interface ToolCallCompletedArgs extends ProviderTurnEventOptions {
  arguments?: Record<string, JsonValue>;
  error?: string;
  itemId?: string;
  result?: JsonValue;
  status?: "pending" | "completed" | "failed" | "interrupted";
  tool?: string;
}

type ToolCallStartedArgs = ToolCallCompletedArgs;

interface CommandCompletedArgs extends ProviderTurnEventOptions {
  aggregatedOutput?: string;
  approvalStatus?: "waiting_for_approval" | "approved" | "denied" | null;
  command: string;
  cwd?: string;
  exitCode?: number;
  itemId?: string;
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
  approvalStatus?: "waiting_for_approval" | "approved" | "denied" | null;
  changes: Array<{
    diff?: string;
    kind?: "add" | "delete" | "update";
    path: string;
  }>;
  itemId?: string;
  status?: "pending" | "completed" | "failed" | "interrupted";
}

type FileChangeStartedArgs = FileChangeCompletedArgs;

interface FileChangeOutputDeltaArgs extends ProviderTurnEventOptions {
  delta: string;
  itemId: string;
}

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

interface SystemOperationArgs extends EventFactoryRowOptions {
  message: string;
  metadata?: Record<string, JsonValue>;
  operation?: string;
  operationId?: string;
  status?: string;
}

interface PermissionGrantLifecycleArgs extends DefaultTurnEventOptions {
  interactionId?: string;
  itemId?: string;
  message?: string;
  providerId?: string;
  providerRequestId?: string;
  status?: "pending" | "completed" | "denied" | "failed" | "expired";
  toolName?: string;
}

interface ManagerUserMessageArgs extends EventFactoryRowOptions {
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
  clientThreadStart(
    args: ClientThreadStartArgs,
  ): ThreadEventRowOfType<"client/thread/start">;
  clientTurnRequested(
    args: ClientTurnRequestedArgs,
  ): ThreadEventRowOfType<"client/turn/requested">;
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
  fileChangeOutputDelta(
    args: FileChangeOutputDeltaArgs,
  ): ThreadEventRowOfType<"item/fileChange/outputDelta">;
  fileChangeStarted(
    args: FileChangeStartedArgs,
  ): ThreadEventRowOfType<"item/started">;
  inputAccepted(
    args: InputAcceptedArgs,
  ): ThreadEventRowOfType<"turn/input/accepted">;
  managerUserMessage(
    args: ManagerUserMessageArgs,
  ): ThreadEventRowOfType<"system/manager/user_message">;
  permissionGrantLifecycle(
    args?: PermissionGrantLifecycleArgs,
  ): ThreadEventRowOfType<"system/permissionGrant/lifecycle">;
  providerError(
    args: ProviderErrorArgs,
  ): ThreadEventRowOfType<"provider/error">;
  providerUnhandled(
    args?: ProviderUnhandledArgs,
  ): ThreadEventRowOfType<"provider/unhandled">;
  providerUserMessage(
    args: ProviderUserMessageArgs,
  ): ThreadEventRowOfType<"item/completed">;
  reasoningCompleted(
    args: ReasoningCompletedArgs,
  ): ThreadEventRowOfType<"item/completed">;
  reasoningDelta(
    args: ReasoningDeltaArgs,
  ): ThreadEventRowOfType<"item/reasoning/textDelta">;
  systemError(args: SystemErrorArgs): ThreadEventRowOfType<"system/error">;
  systemOperation(
    args: SystemOperationArgs,
  ): ThreadEventRowOfType<"system/operation">;
  threadProvisioning(
    args: ThreadProvisioningArgs,
  ): ThreadEventRowOfType<"system/thread-provisioning">;
  toolCallCompleted(
    args: ToolCallCompletedArgs,
  ): ThreadEventRowOfType<"item/completed">;
  toolCallStarted(
    args: ToolCallStartedArgs,
  ): ThreadEventRowOfType<"item/started">;
  threadCompacted(
    args?: ProviderTurnEventOptions,
  ): ThreadEventRowOfType<"thread/compacted">;
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

export function flattenEventProjectionMessages(
  projection: EventProjection,
): EventProjectionMessage[] {
  const messages: EventProjectionMessage[] = [];
  for (const entry of projection.entries) {
    if (entry.kind === "projected-message") {
      messages.push(entry.message);
      continue;
    }
    if (entry.turn.messages) {
      messages.push(...entry.turn.messages);
      continue;
    }
    if (entry.turn.terminalMessage) {
      messages.push(entry.turn.terminalMessage);
    }
  }
  return messages;
}

export function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

export function assertMonotonicSourceSeq(
  messages: EventProjectionMessage[],
): void {
  for (let i = 1; i < messages.length; i += 1) {
    const prev = messages[i - 1];
    const next = messages[i];
    expect(prev).toBeDefined();
    expect(next).toBeDefined();
    if (!prev || !next) continue;
    expect(next.sourceSeqStart).toBeGreaterThanOrEqual(prev.sourceSeqStart);
  }
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
          },
        },
      };
    },
    clientThreadStart(args) {
      const base = nextThreadScopedRowBase("client-thread-start", args);
      return {
        ...base,
        type: "client/thread/start",
        data: {
          direction: "outbound",
          source: args.source ?? "spawn",
          initiator: args.initiator ?? "user",
          request: {
            method: "thread/start",
            params: {},
          },
        },
      };
    },
    clientTurnRequested(args) {
      const base = nextThreadScopedRowBase("client-turn-requested", args);
      return {
        ...base,
        type: "client/turn/requested",
        data: {
          direction: "outbound",
          requestId: args.requestId ?? clientRequestIdForSequence(base.seq),
          source: args.source ?? "tell",
          initiator: args.initiator ?? "user",
          input: args.input ?? [{ type: "text", text: args.text }],
          target: args.target ?? { kind: "new-turn" },
          request: {
            method: args.requestMethod ?? "turn/start",
            params: {},
          },
          execution: args.execution ?? defaultExecution,
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
    fileChangeOutputDelta(args) {
      const base = nextProviderTurnScopedRowBase(
        "file-change-output-delta",
        args,
      );
      return {
        ...base,
        type: "item/fileChange/outputDelta",
        data: {
          ...providerFields(args),
          itemId: args.itemId,
          delta: args.delta,
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
    managerUserMessage(args) {
      const base = {
        ...nextRowBase("manager-user-message", args),
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
        type: "system/permissionGrant/lifecycle",
        data: {
          interactionId: args.interactionId ?? "pi_123",
          providerId: args.providerId ?? "codex",
          providerRequestId: args.providerRequestId ?? "request-123",
          status: args.status ?? "pending",
          message:
            args.message ??
            `Waiting for approval to grant ${args.toolName ?? "Bash"}`,
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
      const base = nextThreadScopedRowBase("system-operation", args);
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
        data: providerFields(args),
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
            id: args.itemId ?? `user-${base.seq}`,
            content: args.content ?? [{ type: "text", text: args.text }],
          },
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

// Tests use small synthetic event timestamps (seq=1, 2, ...). Default the
// projection's snapshot time to 0 so pending duration computations
// (`nowMs - startedAt`) stay deterministic and below the >1s display
// threshold. Tests that need a non-zero pending duration pass `nowMs`
// explicitly via `projectionOptions`.
const DEFAULT_FIXTURE_NOW_MS = 0;

export function renderTimelineFixture(
  args: RenderTimelineFixtureArgs,
): RenderedTimelineFixture {
  const decodedEvents = args.events.map((row) => decodeThreadEventRow(row));
  const includeNestedRows = args.includeNestedRows ?? true;
  const nowMs = args.projectionOptions.nowMs ?? DEFAULT_FIXTURE_NOW_MS;
  const projection = buildEventProjection(decodedEvents, {
    ...args.projectionOptions,
    nowMs,
    turnMessageDetail: includeNestedRows
      ? "full"
      : args.projectionOptions.turnMessageDetail,
  });
  const viewMode =
    args.projectionOptions.threadType === "manager"
      ? "manager-conversation"
      : "standard";
  const commonProjectionOptions = {
    includeDebugRawEvents:
      args.projectionOptions.includeDebugRawEvents ?? false,
    includeOptionalOperations:
      args.projectionOptions.includeOptionalOperations ?? false,
    includeProviderUnhandledOperations:
      args.projectionOptions.includeProviderUnhandledOperations ?? false,
    systemClientRequestVisibility:
      args.projectionOptions.systemClientRequestVisibility,
    threadStatus: args.projectionOptions.threadStatus ?? "idle",
    nowMs,
  };
  const timeline = buildThreadTimelineFromEvents({
    contextWindowEvents: [],
    events: decodedEvents,
    options:
      viewMode === "manager-conversation"
        ? {
            ...commonProjectionOptions,
            viewMode,
          }
        : {
            ...commonProjectionOptions,
            includeNestedRows,
            turnMessageDetail: includeNestedRows
              ? "full"
              : args.projectionOptions.turnMessageDetail,
            viewMode,
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
    projection,
    rows,
    text,
    turnRows,
  };
}

export function renderTimelinePrefixes(
  args: RenderTimelinePrefixesArgs,
): RenderedTimelineFixture[] {
  const startAt = args.startAt ?? 1;
  return args.events
    .map((_, index) => index + 1)
    .filter((prefixLength) => prefixLength >= startAt)
    .map((prefixLength) =>
      renderTimelineFixture({
        events: args.events.slice(0, prefixLength),
        includeNestedRows: args.includeNestedRows,
        projectionOptions: args.projectionOptions,
        verbose: args.verbose,
      }),
    );
}

export function messageKinds(
  messages: readonly EventProjectionMessage[],
): string[] {
  return messages.map((message) => message.kind);
}
