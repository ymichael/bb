import { expect } from "vitest";
import type {
  PromptInput,
  ProvisioningTranscriptEntry,
  ResolvedThreadExecutionOptions,
  SystemThreadProvisioningStatus,
  JsonValue,
  ThreadEventRow,
  ThreadEventRowOfType,
  ThreadEventUserContent,
  ThreadTurnInitiator,
  TimelineRow,
  TimelineToolGroupRow,
  ViewMessage,
  ViewProjection,
} from "@bb/domain";
import type { ToViewProjectionOptions } from "@bb/domain";
import {
  buildTimelineRows,
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
  toolGroups: TimelineToolGroupRow[];
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

type ClientTurnRequestedArgs = EventFactoryRowOptions & {
  execution?: ResolvedThreadExecutionOptions;
  initiator?: ThreadTurnInitiator;
  input?: PromptInput[];
  source?: "spawn" | "tell";
  text: string;
};

type ClientThreadStartArgs = ClientTurnRequestedArgs;

interface UserMessageAckArgs extends ProviderTurnEventOptions {
  clientRequestSequence?: number;
  content?: ThreadEventUserContent[];
  itemId?: string;
  text: string;
}

interface AssistantCompletedArgs extends ProviderTurnEventOptions {
  itemId?: string;
  text: string;
}

interface ToolCallCompletedArgs extends ProviderTurnEventOptions {
  arguments?: Record<string, JsonValue>;
  itemId?: string;
  status?: "pending" | "completed" | "failed" | "interrupted";
  tool?: string;
}

interface CommandCompletedArgs extends ProviderTurnEventOptions {
  aggregatedOutput?: string;
  approvalStatus?: "waiting_for_approval" | "approved" | "denied" | null;
  command: string;
  cwd?: string;
  exitCode?: number;
  itemId?: string;
  status?: "pending" | "completed" | "failed" | "interrupted";
}

interface WebSearchCompletedArgs extends ProviderTurnEventOptions {
  action?: string;
  itemId?: string;
  outputText?: string;
  query: string;
}

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

interface TurnPlanUpdatedArgs extends ProviderTurnEventOptions {
  plan: Array<{
    status: "pending" | "active" | "completed";
    step: string;
  }>;
}

interface ThreadProvisioningArgs extends EventFactoryRowOptions {
  entries: ProvisioningTranscriptEntry[];
  environmentId?: string;
  status: SystemThreadProvisioningStatus;
}

interface SystemErrorArgs extends EventFactoryRowOptions {
  code?: string;
  detail?: string;
  message: string;
}

interface PermissionGrantLifecycleArgs extends EventFactoryRowOptions {
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

export interface TimelineEventFactory {
  assistantCompleted(args: AssistantCompletedArgs): ThreadEventRowOfType<"item/completed">;
  clientThreadStart(args: ClientThreadStartArgs): ThreadEventRowOfType<"client/thread/start">;
  clientTurnRequested(args: ClientTurnRequestedArgs): ThreadEventRowOfType<"client/turn/requested">;
  commandCompleted(args: CommandCompletedArgs): ThreadEventRowOfType<"item/completed">;
  fileChangeCompleted(args: FileChangeCompletedArgs): ThreadEventRowOfType<"item/completed">;
  managerUserMessage(args: ManagerUserMessageArgs): ThreadEventRowOfType<"system/manager/user_message">;
  permissionGrantLifecycle(args?: PermissionGrantLifecycleArgs): ThreadEventRowOfType<"system/permissionGrant/lifecycle">;
  systemError(args: SystemErrorArgs): ThreadEventRowOfType<"system/error">;
  threadProvisioning(args: ThreadProvisioningArgs): ThreadEventRowOfType<"system/thread-provisioning">;
  toolCallCompleted(args: ToolCallCompletedArgs): ThreadEventRowOfType<"item/completed">;
  turnCompleted(args?: ProviderTurnEventOptions & { status?: "completed" | "failed" | "interrupted" }): ThreadEventRowOfType<"turn/completed">;
  turnPlanUpdated(args: TurnPlanUpdatedArgs): ThreadEventRowOfType<"turn/plan/updated">;
  turnStarted(args?: ProviderTurnEventOptions): ThreadEventRowOfType<"turn/started">;
  userMessageAck(args: UserMessageAckArgs): ThreadEventRowOfType<"item/completed">;
  webSearchCompleted(args: WebSearchCompletedArgs): ThreadEventRowOfType<"item/completed">;
}

export function fromRows(rows: ThreadEventRow[]): ThreadEventWithMeta[] {
  return rows.map((row) => decodeRow(withExplicitApprovalStatus(row)));
}

export function flattenProjectionMessages(projection: ViewProjection): ViewMessage[] {
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

  function providerFields(args: ProviderTurnEventOptions | undefined) {
    return {
      providerThreadId: args?.providerThreadId ?? defaults.providerThreadId ?? "provider-thread-1",
      turnId: args?.turnId ?? defaults.turnId ?? "turn-1",
    };
  }

  return {
    assistantCompleted(args) {
      const base = nextRowBase("assistant-completed", args);
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
      const base = nextRowBase("client-thread-start", args);
      return {
        ...base,
        type: "client/thread/start",
        data: {
          direction: "outbound",
          source: args.source ?? "spawn",
          initiator: args.initiator ?? "user",
          input: args.input ?? [{ type: "text", text: args.text }],
          request: {
            method: "thread/start",
            params: {},
          },
          execution: args.execution ?? {
            ...defaultExecution,
            source: "client/thread/start",
          },
        },
      };
    },
    clientTurnRequested(args) {
      const base = nextRowBase("client-turn-requested", args);
      return {
        ...base,
        type: "client/turn/requested",
        data: {
          direction: "outbound",
          source: args.source ?? "tell",
          initiator: args.initiator ?? "user",
          input: args.input ?? [{ type: "text", text: args.text }],
          request: {
            method: "turn/start",
            params: {},
          },
          execution: args.execution ?? defaultExecution,
        },
      };
    },
    commandCompleted(args) {
      const base = nextRowBase("command-completed", args);
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
    fileChangeCompleted(args) {
      const base = nextRowBase("file-change-completed", args);
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
    managerUserMessage(args) {
      const base = nextRowBase("manager-user-message", args);
      return {
        ...base,
        type: "system/manager/user_message",
        data: {
          text: args.text,
          turnId: args.turnId ?? defaults.turnId ?? "turn-1",
        },
      };
    },
    permissionGrantLifecycle(args = {}) {
      const base = nextRowBase("permission-grant-lifecycle", args);
      return {
        ...base,
        type: "system/permissionGrant/lifecycle",
        data: {
          interactionId: args.interactionId ?? "pi_123",
          providerId: args.providerId ?? "codex",
          providerRequestId: args.providerRequestId ?? "request-123",
          status: args.status ?? "pending",
          message: args.message ?? `Waiting for approval to grant ${args.toolName ?? "Bash"}`,
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
    systemError(args) {
      const base = nextRowBase("system-error", args);
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
    threadProvisioning(args) {
      const base = nextRowBase("thread-provisioning", args);
      return {
        ...base,
        type: "system/thread-provisioning",
        data: {
          status: args.status,
          environmentId: args.environmentId ?? "env-1",
          entries: args.entries,
        },
      };
    },
    toolCallCompleted(args) {
      const base = nextRowBase("tool-call-completed", args);
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
            status: args.status ?? "completed",
          },
        },
      };
    },
    turnCompleted(args) {
      const base = nextRowBase("turn-completed", args);
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
      const base = nextRowBase("turn-plan-updated", args);
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
      const base = nextRowBase("turn-started", args);
      return {
        ...base,
        type: "turn/started",
        data: providerFields(args),
      };
    },
    userMessageAck(args) {
      const base = nextRowBase("user-message-ack", args);
      return {
        ...base,
        type: "item/completed",
        data: {
          ...providerFields(args),
          item: {
            type: "userMessage",
            id: args.itemId ?? `user-${base.seq}`,
            content: args.content ?? [{ type: "text", text: args.text }],
            ...(args.clientRequestSequence !== undefined
              ? { clientRequestSequence: args.clientRequestSequence }
              : {}),
          },
        },
      };
    },
    webSearchCompleted(args) {
      const base = nextRowBase("web-search-completed", args);
      return {
        ...base,
        type: "item/completed",
        data: {
          ...providerFields(args),
          item: {
            type: "webSearch",
            id: args.itemId ?? `web-${base.seq}`,
            query: args.query,
            action: args.action,
            outputText: args.outputText,
          },
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
  const rows = buildTimelineRows(projection, {
    includeToolGroupMessages: args.includeToolGroupMessages ?? true,
  });
  const messages = flattenProjectionMessagesDeep(projection);
  const text = formatTimelineAsText(rows, {
    color: false,
    verbose: args.verbose ?? true,
  });
  const toolGroups = rows.filter(
    (row): row is TimelineToolGroupRow => row.kind === "tool-group",
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

export function messageKinds(messages: readonly ViewMessage[]): string[] {
  return messages.map((message) => message.kind);
}
