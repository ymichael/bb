import { expect } from "vitest";
import { threadScope, turnScope } from "@bb/domain";
import type {
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
  TimelineRow,
  ViewMessage,
  ViewProjection,
} from "@bb/domain";
import type { ToViewProjectionOptions } from "@bb/domain";
import {
  buildGroupedTimelineRows,
  decodeRow,
  flattenProjectionMessagesDeep,
  formatTimelineAsText,
  toViewProjection,
} from "../src/index.js";
import type { ThreadEventWithMeta } from "../src/to-view-messages.js";

export interface RenderTimelineFixtureArgs {
  events: ThreadEventRow[];
  includeToolGroupMessages?: boolean;
  projectionOptions: ToViewProjectionOptions;
  verbose?: boolean;
}

export interface RenderedTimelineFixture {
  events: ThreadEventRow[];
  messages: ViewMessage[];
  projection: ViewProjection;
  rows: TimelineRow[];
  text: string;
  toolGroups: Extract<TimelineRow, { kind: "turn-summary" }>[];
}

export interface RenderTimelinePrefixesArgs extends RenderTimelineFixtureArgs {
  startAt?: number;
}

export type StableTimelineRowStatus =
  | "pending"
  | "completed"
  | "error"
  | "interrupted";

export interface LogicalTimelineRow {
  key: string;
  status: StableTimelineRowStatus;
  title: string;
}

export type LogicalTimelineRowResolver = (
  row: TimelineRow,
) => LogicalTimelineRow | null;

export interface PrefixTerminalStabilityArgs extends RenderTimelinePrefixesArgs {
  resolveRow: LogicalTimelineRowResolver;
}

export interface CollectLogicalTimelineRowsArgs {
  resolveRow: LogicalTimelineRowResolver;
  rows: TimelineRow[];
}

interface AppendResolvedLogicalRowArgs {
  resolveRow: LogicalTimelineRowResolver;
  rows: LogicalTimelineRow[];
  timelineRow: TimelineRow;
}

interface TerminalRowSnapshot extends LogicalTimelineRow {
  prefixLength: number;
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
  requestMethod?: "thread/start" | "turn/start";
  source?: "spawn" | "tell";
  target?: TurnRequestTarget;
  text: string;
};

type ClientThreadStartArgs = ClientTurnRequestedArgs;

interface InputAcceptedArgs extends ProviderTurnEventOptions {
  clientRequestSequence: number;
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
  return rows.map((row) => decodeRow(withExplicitApprovalStatus(row)));
}

export function flattenProjectionMessages(
  projection: ViewProjection,
): ViewMessage[] {
  const messages: ViewMessage[] = [];
  for (const entry of projection.entries) {
    if (entry.kind === "message") {
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

export function assertMonotonicSourceSeq(messages: ViewMessage[]): void {
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
          clientRequestSequence: args.clientRequestSequence,
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

export function renderTimelineFixture(
  args: RenderTimelineFixtureArgs,
): RenderedTimelineFixture {
  const decodedEvents = args.events.map((row) => decodeRow(row));
  const projection = toViewProjection(decodedEvents, args.projectionOptions);
  const rows = buildGroupedTimelineRows(projection, {
    includeNestedRows: args.includeToolGroupMessages ?? true,
  });
  const messages = flattenProjectionMessagesDeep(projection);
  const text = formatTimelineAsText(rows, {
    color: false,
    verbose: args.verbose ?? true,
  });
  const toolGroups = rows.filter(
    (row): row is Extract<TimelineRow, { kind: "turn-summary" }> =>
      row.kind === "turn-summary",
  );

  return {
    events: args.events,
    messages,
    projection,
    rows,
    text,
    toolGroups,
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
        includeToolGroupMessages: args.includeToolGroupMessages,
        projectionOptions: args.projectionOptions,
        verbose: args.verbose,
      }),
    );
}

function isTerminalStatus(status: StableTimelineRowStatus): boolean {
  return status !== "pending";
}

function appendResolvedLogicalRow(args: AppendResolvedLogicalRowArgs): void {
  const logicalRow = args.resolveRow(args.timelineRow);
  if (logicalRow) {
    args.rows.push(logicalRow);
  }
}

function appendLogicalRowsFromTimelineRow(
  args: AppendResolvedLogicalRowArgs,
): void {
  appendResolvedLogicalRow(args);

  switch (args.timelineRow.kind) {
    case "message":
      return;
    case "tool-bundle":
    case "assistant-step-summary":
      for (const childRow of args.timelineRow.rows) {
        appendLogicalRowsFromTimelineRow({
          rows: args.rows,
          timelineRow: childRow,
          resolveRow: args.resolveRow,
        });
      }
      return;
    case "turn-summary":
      if (!args.timelineRow.rows) {
        return;
      }
      for (const childRow of args.timelineRow.rows) {
        appendLogicalRowsFromTimelineRow({
          rows: args.rows,
          timelineRow: childRow,
          resolveRow: args.resolveRow,
        });
      }
      return;
    default:
      return;
  }
}

export function collectLogicalTimelineRows(
  args: CollectLogicalTimelineRowsArgs,
): LogicalTimelineRow[] {
  const logicalRows: LogicalTimelineRow[] = [];
  for (const row of args.rows) {
    appendLogicalRowsFromTimelineRow({
      rows: logicalRows,
      timelineRow: row,
      resolveRow: args.resolveRow,
    });
  }
  return logicalRows;
}

export function expectTerminalRowsNeverRegress(
  args: PrefixTerminalStabilityArgs,
): void {
  const terminalByKey = new Map<string, TerminalRowSnapshot>();
  const prefixes = renderTimelinePrefixes(args);

  for (const prefix of prefixes) {
    const currentRowsByKey = new Map<string, LogicalTimelineRow>();
    for (const logicalRow of collectLogicalTimelineRows({
      rows: prefix.rows,
      resolveRow: args.resolveRow,
    })) {
      currentRowsByKey.set(logicalRow.key, logicalRow);
    }

    for (const previous of terminalByKey.values()) {
      const current = currentRowsByKey.get(previous.key);
      if (!current) {
        throw new Error(
          `Terminal row ${previous.key} disappeared after prefix ${previous.prefixLength}`,
        );
      }
      expect(current.status).toBe(previous.status);
      expect(current.title).toBe(previous.title);
    }

    for (const current of currentRowsByKey.values()) {
      if (isTerminalStatus(current.status) && !terminalByKey.has(current.key)) {
        terminalByKey.set(current.key, {
          ...current,
          prefixLength: prefix.events.length,
        });
      }
    }
  }
}

export function messageKinds(messages: readonly ViewMessage[]): string[] {
  return messages.map((message) => message.kind);
}
