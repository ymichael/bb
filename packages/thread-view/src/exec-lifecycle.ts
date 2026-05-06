import {
  jsonValueSchema,
  type JsonObject,
  ThreadEvent,
  ThreadEventItemApprovalStatus,
  ThreadEventItemStatus,
} from "@bb/domain";
import { getEventParentToolCallId, type EventMeta } from "./event-decode.js";
import type {
  EventProjectionApprovalLifecycleStatus,
  EventProjectionFileEditMessage,
  EventProjectionToolCallMessage,
  EventProjectionToolParsedIntent,
} from "./event-projection-types.js";
import { getFirstStringField } from "./format-helpers.js";
import {
  baseToolName,
  extractShellCommandFromString,
  formatToolCallCommand,
  formatToolCallOutput,
  isDelegationToolName,
  isStructuredListToolName,
  isStructuredReadToolName,
  isStructuredSearchToolName,
  parseShellCommandIntents,
  stripAgentOutputMetadata,
} from "./tool-call-parsing.js";

interface DelegationMetadata {
  subagentType?: string;
  description?: string;
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

function itemStatusToExecStatus(
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

export function itemStatusToToolStatus(
  status: ThreadEventItemStatus,
): EventProjectionToolCallMessage["status"] {
  return itemStatusToExecStatus(status);
}

export function itemStatusToFileEditStatus(
  status: ThreadEventItemStatus,
): EventProjectionFileEditMessage["status"] {
  return itemStatusToExecStatus(status);
}

export interface ExecutionUpdateBase {
  callId: string;
  output?: string;
  /**
   * Wall-clock millis when the work reached a terminal status. `null` while
   * pending. The projection records this on `end` events so the renderer
   * can derive duration from `(message.startedAt, completedAt)`.
   */
  completedAt: number | null;
  status?: EventProjectionToolCallMessage["status"];
  parentToolCallId?: string;
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
  parsedIntents?: EventProjectionToolParsedIntent[];
  approvalStatus?: EventProjectionApprovalLifecycleStatus | null;
}

export interface DelegationExecutionUpdate
  extends ExecutionUpdateBase, DelegationMetadata {
  kind: "delegation";
  toolName?: string;
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

export type ExecLifecycleEvent =
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

function toExecDefaultStatus(
  kind: "begin" | "end",
): EventProjectionToolCallMessage["status"] {
  if (kind === "begin") return "pending";
  return "completed";
}

function buildStructuredReadIntents(
  toolName: string,
  args: Record<string, unknown> | null,
): EventProjectionToolParsedIntent[] {
  const path = getFirstStringField(args, ["file_path", "file", "path"]);
  if (!path) {
    return [];
  }

  return [
    {
      type: "read",
      cmd: formatToolCallCommand(toolName, args),
      name: baseToolName(toolName),
      path,
    },
  ];
}

function buildStructuredSearchIntents(
  toolName: string,
  args: Record<string, unknown> | null,
): EventProjectionToolParsedIntent[] {
  const query = getFirstStringField(args, ["pattern", "query"]);
  if (!query) {
    return [];
  }

  return [
    {
      type: "search",
      cmd: formatToolCallCommand(toolName, args),
      query,
      path: getFirstStringField(args, ["path"]) ?? null,
    },
  ];
}

function buildStructuredListIntents(
  toolName: string,
  args: Record<string, unknown> | null,
): EventProjectionToolParsedIntent[] {
  const path = getFirstStringField(args, ["path", "pattern"]);
  if (!path) {
    return [];
  }

  return [
    {
      type: "list_files",
      cmd: formatToolCallCommand(toolName, args),
      path,
    },
  ];
}

function getStructuredToolParsedIntents(
  toolName: string,
  args: Record<string, unknown> | null,
): EventProjectionToolParsedIntent[] {
  const baseName = baseToolName(toolName);
  if (isStructuredReadToolName(baseName)) {
    return buildStructuredReadIntents(toolName, args);
  }
  if (isStructuredSearchToolName(baseName)) {
    return buildStructuredSearchIntents(toolName, args);
  }
  if (isStructuredListToolName(baseName)) {
    return buildStructuredListIntents(toolName, args);
  }
  return [];
}

function getDelegationMetadata(
  toolName: string,
  args: Record<string, unknown> | null,
): DelegationMetadata {
  if (!isDelegationToolName(toolName)) {
    return {};
  }

  const subagentType = getFirstStringField(args, [
    "subagent_type",
    "subagentType",
  ]);
  const description = getFirstStringField(args, ["description", "prompt"]);
  return {
    ...(subagentType ? { subagentType } : {}),
    ...(description ? { description } : {}),
  };
}

function formatToolCallResultOutput(toolName: string, output: string): string {
  if (baseToolName(toolName) === "Agent") {
    return stripAgentOutputMetadata(output);
  }
  return formatToolCallOutput(toolName, output);
}

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
        : (itemStatusToToolStatus(decoded.item.status) ??
          toExecDefaultStatus(kind));
    const completedAt = kind === "end" ? meta.createdAt : null;

    const command = extractShellCommandFromString(decoded.item.command);
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
        ...(parentToolCallId ? { parentToolCallId } : {}),
      },
    };
  }

  return null;
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

  if (decoded.type === "item/started" || decoded.type === "item/completed") {
    if (decoded.item.type !== "toolCall") return null;

    const callId = decoded.item.id;
    if (!callId) return null;
    const toolName = decoded.item.tool ?? "tool";
    const serverPrefix = decoded.item.server ? `${decoded.item.server}:` : "";
    const fullToolName = `${serverPrefix}${toolName}`;
    const parsedArgs = decoded.item.arguments ?? null;

    const kind = decoded.type === "item/started" ? "begin" : "end";
    const status =
      kind === "end"
        ? (itemStatusToToolStatus(decoded.item.status) ?? "completed")
        : "pending";
    const completedAt = kind === "end" ? meta.createdAt : null;
    const result = decoded.item.result;
    const rawOutput =
      typeof result === "string"
        ? result
        : result !== undefined
          ? JSON.stringify(result)
          : undefined;
    const output =
      rawOutput !== undefined
        ? formatToolCallResultOutput(fullToolName, rawOutput)
        : undefined;
    const errorField = decoded.item.error;
    const parsedIntents = getStructuredToolParsedIntents(
      fullToolName,
      parsedArgs,
    );
    const executionKind = isDelegationToolName(fullToolName)
      ? "delegation"
      : "tool-call";
    const delegationMetadata = getDelegationMetadata(fullToolName, parsedArgs);
    const toolArgs = parseToolArgs(parsedArgs);

    const baseCall = {
      callId,
      toolName: fullToolName,
      output: kind === "end" ? (output ?? errorField) : undefined,
      completedAt,
      status,
      ...(parentToolCallId ? { parentToolCallId } : {}),
    };

    if (executionKind === "delegation") {
      return {
        kind,
        call: {
          ...baseCall,
          kind: executionKind,
          ...delegationMetadata,
        },
      };
    }

    return {
      kind,
      call: {
        ...baseCall,
        kind: executionKind,
        toolArgs,
        parsedIntents,
        ...delegationMetadata,
      },
    };
  }

  return null;
}
