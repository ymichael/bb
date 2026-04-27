import type { ThreadEvent } from "./provider-event.js";
import { getThreadEventScopeTurnId } from "./thread-event-scope.js";

export const bufferedTextInstanceKindValues = [
  "assistant",
  "reasoning",
] as const;

export type BufferedTextInstanceKind =
  (typeof bufferedTextInstanceKindValues)[number];

export interface BufferedTextInstanceIdentity {
  itemId: string;
  kind: BufferedTextInstanceKind;
  parentToolCallId: string | null;
  turnId: string;
}

export interface ResolveBufferedTextIdentityArgs {
  decoded: ThreadEvent;
  kind: BufferedTextInstanceKind;
  parentToolCallId?: string;
  turnId?: string;
}

export function createBufferedTextInstanceKey(
  identity: BufferedTextInstanceIdentity,
): string {
  return [
    `kind:${identity.kind}`,
    `turn:${identity.turnId}`,
    `parent:${identity.parentToolCallId ?? "root"}`,
    `item:${identity.itemId}`,
  ].join("|");
}

function getThreadEventTurnId(decoded: ThreadEvent): string | undefined {
  return getThreadEventScopeTurnId(decoded.scope);
}

function getThreadEventParentToolCallId(
  decoded: ThreadEvent,
): string | undefined {
  if ("item" in decoded && "parentToolCallId" in decoded.item) {
    return decoded.item.parentToolCallId;
  }
  if ("parentToolCallId" in decoded) {
    return decoded.parentToolCallId;
  }
  return undefined;
}

export function resolveBufferedTextIdentity(
  args: ResolveBufferedTextIdentityArgs,
): BufferedTextInstanceIdentity | null {
  const turnId = args.turnId ?? getThreadEventTurnId(args.decoded);
  if (!turnId) {
    return null;
  }

  const parentToolCallId =
    args.parentToolCallId ??
    getThreadEventParentToolCallId(args.decoded) ??
    null;

  if (args.kind === "assistant") {
    if (args.decoded.type === "item/agentMessage/delta") {
      return {
        itemId: args.decoded.itemId,
        kind: "assistant",
        parentToolCallId,
        turnId,
      };
    }
    if (
      args.decoded.type === "item/completed" &&
      args.decoded.item.type === "agentMessage"
    ) {
      return {
        itemId: args.decoded.item.id,
        kind: "assistant",
        parentToolCallId,
        turnId,
      };
    }
    return null;
  }

  if (args.decoded.type === "item/reasoning/summaryTextDelta") {
    return {
      itemId: args.decoded.itemId,
      kind: "reasoning",
      parentToolCallId,
      turnId,
    };
  }
  if (args.decoded.type === "item/reasoning/textDelta") {
    return {
      itemId: args.decoded.itemId,
      kind: "reasoning",
      parentToolCallId,
      turnId,
    };
  }
  if (
    args.decoded.type === "item/completed" &&
    args.decoded.item.type === "reasoning"
  ) {
    return {
      itemId: args.decoded.item.id,
      kind: "reasoning",
      parentToolCallId,
      turnId,
    };
  }
  return null;
}
