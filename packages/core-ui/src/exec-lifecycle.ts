import type { ThreadEvent, ThreadEventItemStatus } from "@bb/domain";
import { getEventParentToolCallId, type EventMeta } from "./event-decode.js";
import type { ViewFileEditMessage, ViewToolCallMessage, ViewToolCallSummary, ViewToolParsedIntent } from "@bb/domain";
import { durationToString, getFirstStringField } from "./format-helpers.js";
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

export interface ExecLifecycleContext {
  /**
   * Tracks call start timestamps so projection can synthesize durations when a
   * provider completion event omits `durationMs`.
   */
  callStartedAtById: Map<string, number>;
}

export function createExecLifecycleContext(): ExecLifecycleContext {
  return {
    callStartedAtById: new Map(),
  };
}

type ExecItemViewStatus = ViewToolCallMessage["status"];

function itemStatusToExecStatus(status: ThreadEventItemStatus): ExecItemViewStatus {
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

export function itemStatusToToolStatus(status: ThreadEventItemStatus): ViewToolCallMessage["status"] {
  return itemStatusToExecStatus(status);
}

export function itemStatusToFileEditStatus(status: ThreadEventItemStatus): ViewFileEditMessage["status"] {
  return itemStatusToExecStatus(status);
}

export interface ExecCallPartial extends Partial<ViewToolCallSummary> {
  callId: string;
  toolName?: string;
  parsedCmd: ViewToolParsedIntent[];
  parentToolCallId?: string;
}

export interface ExecLifecycleEvent {
  kind: "begin" | "end" | "output";
  call: ExecCallPartial;
  appendOutput?: boolean;
}

function toExecDefaultStatus(kind: "begin" | "end"): ViewToolCallMessage["status"] {
  if (kind === "begin") return "pending";
  return "completed";
}

function buildStructuredReadIntents(
  toolName: string,
  args: Record<string, unknown> | null,
): ViewToolParsedIntent[] {
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
): ViewToolParsedIntent[] {
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
): ViewToolParsedIntent[] {
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
): ViewToolParsedIntent[] {
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

  const subagentType = getFirstStringField(args, ["subagent_type", "subagentType"]);
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

function trackCallStart(
  context: ExecLifecycleContext | undefined,
  callId: string,
  startedAt: number,
): void {
  if (!context || context.callStartedAtById.has(callId)) {
    return;
  }
  context.callStartedAtById.set(callId, startedAt);
}

function resolveCallDurationMs(
  context: ExecLifecycleContext | undefined,
  callId: string,
  completedAt: number,
  providerDurationMs: number | undefined,
): number | undefined {
  if (providerDurationMs !== undefined) {
    context?.callStartedAtById.delete(callId);
    return providerDurationMs;
  }

  const startedAt = context?.callStartedAtById.get(callId);
  context?.callStartedAtById.delete(callId);
  if (startedAt === undefined) {
    return undefined;
  }

  const durationMs = completedAt - startedAt;
  return durationMs >= 0 ? durationMs : undefined;
}

export function parseExecLifecycleEvent(
  decoded: ThreadEvent,
  meta: EventMeta,
  parentToolCallIdOverride?: string,
  context?: ExecLifecycleContext,
): ExecLifecycleEvent | null {
  const parentToolCallId =
    parentToolCallIdOverride ?? getEventParentToolCallId(decoded);
  if (decoded.type === "item/commandExecution/outputDelta") {
    const callId = decoded.itemId;
    if (!callId) return null;
    return {
      kind: "output",
      call: {
        callId,
        parsedCmd: [],
        output: decoded.delta,
        status: "pending",
        ...(parentToolCallId ? { parentToolCallId } : {}),
      },
      appendOutput: true,
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
    const durationMs = kind === "end"
      ? resolveCallDurationMs(
          context,
          callId,
          meta.createdAt,
          decoded.item.durationMs,
        )
      : decoded.item.durationMs;
    if (kind === "begin") {
      trackCallStart(context, callId, meta.createdAt);
    }

    const command = extractShellCommandFromString(decoded.item.command);
    return {
      kind,
      call: {
        callId,
        command,
        cwd: decoded.item.cwd,
        parsedCmd: parseShellCommandIntents(command),
        output: decoded.item.aggregatedOutput,
        exitCode,
        durationMs,
        duration: durationToString(durationMs),
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
  context?: ExecLifecycleContext,
): ExecLifecycleEvent | null {
  const parentToolCallId =
    parentToolCallIdOverride ?? getEventParentToolCallId(decoded);
  if (
    decoded.type === "item/toolCall/progress" ||
    decoded.type === "item/mcpToolCall/progress"
  ) {
    return {
      kind: "output",
      call: {
        callId: decoded.itemId,
        parsedCmd: [],
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
    const status = kind === "end"
      ? (itemStatusToToolStatus(decoded.item.status) ?? "completed")
      : "pending";
    const durationMs = kind === "end"
      ? resolveCallDurationMs(
          context,
          callId,
          meta.createdAt,
          decoded.item.durationMs,
        )
      : decoded.item.durationMs;
    if (kind === "begin") {
      trackCallStart(context, callId, meta.createdAt);
    }
    const result = decoded.item.result;
    const rawOutput = typeof result === "string"
      ? result
      : (result !== undefined ? JSON.stringify(result) : undefined);
    const output = rawOutput !== undefined
      ? formatToolCallResultOutput(fullToolName, rawOutput)
      : undefined;
    const errorField = decoded.item.error;
    const parsedCmd = getStructuredToolParsedIntents(fullToolName, parsedArgs);
    const delegationMetadata = getDelegationMetadata(fullToolName, parsedArgs);

    return {
      kind,
      call: {
        callId,
        toolName: fullToolName,
        command: formatToolCallCommand(fullToolName, parsedArgs),
        parsedCmd,
        output: kind === "end" ? (output ?? errorField) : undefined,
        durationMs,
        duration: durationToString(durationMs),
        status,
        ...delegationMetadata,
        ...(parentToolCallId ? { parentToolCallId } : {}),
      },
    };
  }

  return null;
}
