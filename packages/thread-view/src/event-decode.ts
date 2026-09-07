import { buildThreadEvent, getThreadEventScopeTurnId } from "@bb/domain";
import type { ThreadEvent, ThreadEventRow } from "@bb/domain";
import { assertNever } from "./assert-never.js";

export function getEventTurnId(decoded: ThreadEvent): string | undefined {
  return getThreadEventScopeTurnId(decoded.scope);
}

export function getEventProviderThreadId(
  decoded: ThreadEvent,
): string | undefined {
  switch (decoded.type) {
    case "thread/identity":
    case "turn/started":
    case "turn/input/accepted":
    case "thread/name/updated":
    case "thread/compacted":
    case "thread/context/cleared":
    case "thread/goal/updated":
    case "thread/goal/cleared":
    case "item/started":
    case "item/completed":
    case "item/backgroundTask/progress":
    case "item/backgroundTask/completed":
    case "item/delegation/progress":
    case "item/delegation/completed":
    case "item/agentMessage/delta":
    case "item/commandExecution/outputDelta":
    case "item/fileChange/outputDelta":
    case "item/reasoning/summaryTextDelta":
    case "item/reasoning/textDelta":
    case "item/plan/delta":
    case "item/mcpToolCall/progress":
    case "item/toolCall/progress":
    case "thread/tokenUsage/updated":
    case "thread/contextWindowUsage/updated":
    case "turn/plan/updated":
    case "turn/diff/updated":
    case "provider/error":
    case "provider/warning":
    case "provider/modelFallback":
    case "provider/rateLimits/updated":
    case "provider.env-resolved":
    case "thread/extensionState/updated":
    case "provider/unhandled":
      return decoded.providerThreadId;
    case "turn/completed":
      return decoded.providerThreadId ?? undefined;
    case "thread/started":
    case "client/thread/start":
    case "client/turn/requested":
    case "client/turn/rejected":
    case "client/turn/start":
    case "system/error":
    case "system/manager/user_message":
    case "system/thread/interrupted":
    case "system/operation":
    case "system/interaction/lifecycle":
    case "system/permissionGrant/lifecycle":
    case "system/userQuestion/lifecycle":
    case "system/thread-provisioning":
    case "system/provider-turn-watchdog":
      return undefined;
    default:
      return assertNever(decoded);
  }
}

export function getEventParentToolCallId(
  decoded: ThreadEvent,
): string | undefined {
  switch (decoded.type) {
    case "item/started":
    case "item/completed":
    case "item/backgroundTask/progress":
    case "item/backgroundTask/completed":
    case "item/delegation/progress":
    case "item/delegation/completed":
      return decoded.item.parentToolCallId;
    case "item/agentMessage/delta":
    case "item/commandExecution/outputDelta":
    case "item/fileChange/outputDelta":
    case "item/reasoning/summaryTextDelta":
    case "item/reasoning/textDelta":
    case "item/plan/delta":
    case "item/mcpToolCall/progress":
    case "item/toolCall/progress":
    case "provider/unhandled":
    case "turn/started":
      return decoded.parentToolCallId;
    case "thread/started":
    case "thread/identity":
    case "turn/completed":
    case "turn/input/accepted":
    case "thread/name/updated":
    case "thread/compacted":
    case "thread/context/cleared":
    case "thread/goal/updated":
    case "thread/goal/cleared":
    case "thread/tokenUsage/updated":
    case "thread/contextWindowUsage/updated":
    case "turn/plan/updated":
    case "turn/diff/updated":
    case "provider/error":
    case "provider/warning":
    case "provider/modelFallback":
    case "provider/rateLimits/updated":
    case "provider.env-resolved":
    case "thread/extensionState/updated":
    case "client/thread/start":
    case "client/turn/requested":
    case "client/turn/rejected":
    case "client/turn/start":
    case "system/error":
    case "system/manager/user_message":
    case "system/thread/interrupted":
    case "system/operation":
    case "system/interaction/lifecycle":
    case "system/permissionGrant/lifecycle":
    case "system/userQuestion/lifecycle":
    case "system/thread-provisioning":
    case "system/provider-turn-watchdog":
      return undefined;
    default:
      return assertNever(decoded);
  }
}

export interface EventMeta {
  id: string;
  seq: number;
  createdAt: number;
}

function buildEventMeta(row: ThreadEventRow): EventMeta {
  return {
    id: row.id,
    seq: row.seq,
    createdAt: row.createdAt,
  };
}

export function decodeThreadEventRow(row: ThreadEventRow): {
  event: ThreadEvent;
  meta: EventMeta;
} {
  return {
    event: buildThreadEvent(row),
    meta: buildEventMeta(row),
  };
}
