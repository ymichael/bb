import type { ThreadEvent, ThreadEventItemStatus } from "@bb/domain";
import type { EventMeta } from "./event-decode.js";
import type { UIFileEditMessage, UIToolCallMessage, UIToolCallSummary, UIToolParsedIntent } from "@bb/domain";
import { durationToString } from "./format-helpers.js";
import { extractShellCommandFromString, formatToolCallCommand, toolNameToParsedIntents } from "./tool-call-parsing.js";
import { toRecord } from "./unknown-helpers.js";

export function itemStatusToToolStatus(status: ThreadEventItemStatus): UIToolCallMessage["status"] {
  switch (status) {
    case "pending": return "pending";
    case "completed": return "completed";
    case "failed": return "error";
    case "interrupted": return "interrupted";
  }
}

export function itemStatusToFileEditStatus(status: ThreadEventItemStatus): UIFileEditMessage["status"] {
  switch (status) {
    case "pending": return "pending";
    case "completed": return "completed";
    case "failed": return "error";
    case "interrupted": return "interrupted";
  }
}

export interface ExecCallPartial extends Partial<UIToolCallSummary> {
  callId: string;
  toolName?: string;
  parsedCmd: UIToolParsedIntent[];
}

export interface ExecLifecycleEvent {
  kind: "begin" | "end" | "output";
  call: ExecCallPartial;
  appendOutput?: boolean;
}

function toExecDefaultStatus(kind: "begin" | "end"): UIToolCallMessage["status"] {
  if (kind === "begin") return "pending";
  return "completed";
}

export function parseExecLifecycleEvent(
  decoded: ThreadEvent,
  _meta: EventMeta,
): ExecLifecycleEvent | null {
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

    return {
      kind,
      call: {
        callId,
        command: extractShellCommandFromString(decoded.item.command),
        cwd: decoded.item.cwd,
        parsedCmd: [],
        output: decoded.item.aggregatedOutput,
        exitCode,
        durationMs: decoded.item.durationMs,
        duration: durationToString(decoded.item.durationMs),
        status,
      },
    };
  }

  return null;
}

export function parseToolCallLifecycleEvent(
  decoded: ThreadEvent,
  _meta: EventMeta,
): ExecLifecycleEvent | null {
  if (decoded.type === "item/started" || decoded.type === "item/completed") {
    if (decoded.item.type !== "toolCall") return null;

    const callId = decoded.item.id;
    if (!callId) return null;
    const toolName = decoded.item.tool ?? "tool";
    const serverPrefix = decoded.item.server ? `${decoded.item.server}:` : "";
    const fullToolName = `${serverPrefix}${toolName}`;
    const parsedArgs = toRecord(decoded.item.arguments);

    const kind = decoded.type === "item/started" ? "begin" : "end";
    const status = kind === "end"
      ? (itemStatusToToolStatus(decoded.item.status) ?? "completed")
      : "pending";
    const result = decoded.item.result;
    const output = typeof result === "string" ? result : (result !== undefined ? JSON.stringify(result) : undefined);
    const errorField = decoded.item.error;

    return {
      kind,
      call: {
        callId,
        toolName: fullToolName,
        command: formatToolCallCommand(fullToolName, parsedArgs),
        parsedCmd: toolNameToParsedIntents(fullToolName, parsedArgs),
        output: kind === "end" ? (output ?? errorField) : undefined,
        durationMs: decoded.item.durationMs,
        duration: durationToString(decoded.item.durationMs),
        status,
      },
    };
  }

  return null;
}
