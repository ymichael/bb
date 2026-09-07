import type { ThreadEvent } from "@bb/domain";
import { getThreadEventScopeTurnId } from "@bb/domain";

type BufferedTextInstanceKind = "assistant" | "reasoning";

export interface BufferedTextInstanceIdentity {
  itemId: string;
  kind: BufferedTextInstanceKind;
  parentToolCallId: string | null;
  turnId: string;
}

interface ResolveBufferedTextIdentityArgs {
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
  const turnId = args.turnId ?? getThreadEventScopeTurnId(args.decoded.scope);
  if (!turnId) {
    return null;
  }

  const parentToolCallId =
    args.parentToolCallId ??
    getThreadEventParentToolCallId(args.decoded) ??
    null;

  if (args.kind === "assistant") {
    if (
      args.decoded.type === "item/agentMessage/delta" ||
      args.decoded.type === "item/plan/delta"
    ) {
      return {
        itemId: args.decoded.itemId,
        kind: "assistant",
        parentToolCallId,
        turnId,
      };
    }
    if (
      args.decoded.type === "item/completed" &&
      (args.decoded.item.type === "agentMessage" ||
        args.decoded.item.type === "plan")
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

  if (
    args.decoded.type === "item/reasoning/summaryTextDelta" ||
    args.decoded.type === "item/reasoning/textDelta"
  ) {
    return {
      itemId: args.decoded.itemId,
      kind: "reasoning",
      parentToolCallId,
      turnId,
    };
  }
  if (
    (args.decoded.type === "item/started" ||
      args.decoded.type === "item/completed") &&
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
