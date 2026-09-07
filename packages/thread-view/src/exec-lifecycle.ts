import {
  jsonValueSchema,
  type JsonObject,
  ThreadEvent,
  ThreadEventItemApprovalStatus,
  ThreadEventItemPresentation,
  ThreadEventItemStatus,
} from "@bb/domain";
import { getEventParentToolCallId, type EventMeta } from "./event-decode.js";
import type {
  EventProjectionApprovalLifecycleStatus,
  EventProjectionToolCallMessage,
  EventProjectionToolParsedIntent,
} from "./event-projection-types.js";
import {
  extractShellCommandFromString,
  parseShellCommandIntents,
} from "./tool-call-parsing.js";

interface DelegationMetadata {
  subagentType?: string;
  description?: string;
  model?: string;
}

function parseToolArgs(
  args: Record<string, unknown> | null,
): JsonObject | null {
  if (!args) return null;
  const toolArgs: JsonObject = {};
  for (const [key, value] of Object.entries(args)) {
    toolArgs[key] = jsonValueSchema.parse(value);
  }
  return toolArgs;
}

type ExecItemViewStatus = EventProjectionToolCallMessage["status"];

export function itemStatusToExecStatus(
  status: ThreadEventItemStatus,
): ExecItemViewStatus {
  switch (status) {
    case "pending":
      return "pending";
    case "completed":
      return "completed";
    case "failed":
      return "error";
    case "interrupted":
      return "interrupted";
  }
}

export function itemStatusToApprovalStatus(
  status: ThreadEventItemApprovalStatus,
): EventProjectionApprovalLifecycleStatus | null {
  switch (status) {
    case "waiting_for_approval":
      return "waiting_for_approval";
    case "denied":
      return "denied";
    case null:
      return null;
  }
}

interface ExecutionUpdateBase {
  callId: string;
  output?: string;
  completedAt: number | null;
  status?: EventProjectionToolCallMessage["status"];
  parentToolCallId?: string;
  presentation?: ThreadEventItemPresentation;
}

export interface CommandExecutionUpdate extends ExecutionUpdateBase {
  kind: "command";
  command?: string;
  cwd?: string | null;
  parsedIntents?: EventProjectionToolParsedIntent[];
  source?: string | null;
  exitCode?: number | null;
  approvalStatus?: EventProjectionApprovalLifecycleStatus | null;
}

export interface ToolCallExecutionUpdate extends ExecutionUpdateBase {
  kind: "tool-call";
  toolName?: string;
  toolArgs?: JsonObject | null;
  approvalStatus?: EventProjectionApprovalLifecycleStatus | null;
}

export interface DelegationExecutionUpdate
  extends ExecutionUpdateBase, DelegationMetadata {
  kind: "delegation";
  toolName?: string;
  childRef?: string;
  background?: boolean;
}

export type ProviderExecutionUpdate =
  | CommandExecutionUpdate
  | ToolCallExecutionUpdate
  | DelegationExecutionUpdate;

export interface ExecutionOutputUpdate {
  callId: string;
  output: string;
  status?: EventProjectionToolCallMessage["status"];
  parentToolCallId?: string;
}

type ExecLifecycleEvent =
  | {
      kind: "begin" | "end";
      call: ProviderExecutionUpdate;
    }
  | {
      kind: "output";
      output: ExecutionOutputUpdate;
      appendOutput?: boolean;
      replaceOutput?: boolean;
    };

export function parseExecLifecycleEvent(
  decoded: ThreadEvent,
  meta: EventMeta,
  parentToolCallIdOverride?: string,
): ExecLifecycleEvent | null {
  const parentToolCallId =
    parentToolCallIdOverride ?? getEventParentToolCallId(decoded);
  if (decoded.type === "item/commandExecution/outputDelta") {
    const callId = decoded.itemId;
    if (!callId) return null;
    return {
      kind: "output",
      output: {
        callId,
        output: decoded.delta,
        status: "pending",
        ...(parentToolCallId ? { parentToolCallId } : {}),
      },
      ...(decoded.reset ? { replaceOutput: true } : { appendOutput: true }),
    };
  }

  if (
    (decoded.type === "item/started" || decoded.type === "item/completed") &&
    decoded.item.type === "commandExecution"
  ) {
    const callId = decoded.item.id;
    if (!callId) return null;

    const kind = decoded.type === "item/started" ? "begin" : "end";
    const exitCode = decoded.item.exitCode;
    const status =
      exitCode !== undefined && exitCode !== 0
        ? "error"
        : itemStatusToExecStatus(decoded.item.status);
    const completedAt = kind === "end" ? meta.createdAt : null;

    const command = extractShellCommandFromString(decoded.item.command);
    const presentation = decoded.item.presentation;
    return {
      kind,
      call: {
        kind: "command",
        callId,
        command,
        cwd: decoded.item.cwd,
        parsedIntents: parseShellCommandIntents(command),
        output: decoded.item.aggregatedOutput,
        exitCode,
        completedAt,
        approvalStatus: itemStatusToApprovalStatus(decoded.item.approvalStatus),
        status,
        ...(presentation ? { presentation } : {}),
        ...(parentToolCallId ? { parentToolCallId } : {}),
      },
    };
  }

  return null;
}

export const DELEGATION_ITEM_TOOL_NAME = "delegation";

function parseDelegationItemLifecycleEvent(
  decoded: ThreadEvent,
  meta: EventMeta,
  parentToolCallId: string | undefined,
): ExecLifecycleEvent | null {
  if (
    decoded.type !== "item/started" &&
    decoded.type !== "item/completed" &&
    decoded.type !== "item/delegation/progress" &&
    decoded.type !== "item/delegation/completed"
  ) {
    return null;
  }
  if (decoded.item.type !== "delegation") {
    return null;
  }
  const kind =
    decoded.type === "item/started" ||
    decoded.type === "item/delegation/progress"
      ? "begin"
      : "end";
  const status =
    kind === "end" ? itemStatusToExecStatus(decoded.item.status) : "pending";
  const presentation = decoded.item.presentation;
  return {
    kind,
    call: {
      kind: "delegation",
      callId: decoded.item.id,
      toolName: DELEGATION_ITEM_TOOL_NAME,
      childRef: decoded.item.childRef,
      background: decoded.item.background,
      description: decoded.item.label,
      output: decoded.item.summary,
      completedAt: kind === "end" ? meta.createdAt : null,
      status,
      ...(presentation ? { presentation } : {}),
      ...(parentToolCallId ? { parentToolCallId } : {}),
    },
  };
}

export function parseToolCallLifecycleEvent(
  decoded: ThreadEvent,
  meta: EventMeta,
  parentToolCallIdOverride?: string,
): ExecLifecycleEvent | null {
  const parentToolCallId =
    parentToolCallIdOverride ?? getEventParentToolCallId(decoded);
  if (
    decoded.type === "item/toolCall/progress" ||
    decoded.type === "item/mcpToolCall/progress"
  ) {
    return {
      kind: "output",
      output: {
        callId: decoded.itemId,
        output: decoded.message ?? "Progress update",
        status: "pending",
        ...(parentToolCallId ? { parentToolCallId } : {}),
      },
    };
  }

  const delegationEvent = parseDelegationItemLifecycleEvent(
    decoded,
    meta,
    parentToolCallId,
  );
  if (delegationEvent) {
    return delegationEvent;
  }

  if (decoded.type === "item/started" || decoded.type === "item/completed") {
    if (decoded.item.type !== "toolCall") return null;

    const callId = decoded.item.id;
    if (!callId) return null;
    const toolName = decoded.item.tool;
    const serverPrefix = decoded.item.server ? `${decoded.item.server}:` : "";
    const fullToolName = `${serverPrefix}${toolName}`;
    const parsedArgs = decoded.item.arguments ?? null;

    const kind = decoded.type === "item/started" ? "begin" : "end";
    const status =
      kind === "end" ? itemStatusToExecStatus(decoded.item.status) : "pending";
    const completedAt = kind === "end" ? meta.createdAt : null;
    const result = decoded.item.result;
    const output =
      typeof result === "string"
        ? result
        : result !== undefined
          ? JSON.stringify(result)
          : undefined;
    const errorField = decoded.item.error;
    const toolArgs = parseToolArgs(parsedArgs);
    const presentation = decoded.item.presentation;

    return {
      kind,
      call: {
        kind: "tool-call",
        callId,
        toolName: fullToolName,
        output: kind === "end" ? (output ?? errorField) : undefined,
        completedAt,
        status,
        toolArgs,
        ...(presentation ? { presentation } : {}),
        ...(parentToolCallId ? { parentToolCallId } : {}),
      },
    };
  }

  return null;
}
