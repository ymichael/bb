import type { ViewDelegationMessage, ViewMessage, ViewTasksMessage, ViewToolCallMessage } from "@bb/domain";
import { isDelegationToolName } from "./tool-call-parsing.js";

interface IndexedMessage {
  message: ViewMessage;
  index: number;
}

function getStartedAt(message: Pick<ViewMessage, "startedAt" | "createdAt">): number {
  return message.startedAt ?? message.createdAt;
}

function mergeTaskMessages(
  previous: ViewTasksMessage,
  next: ViewTasksMessage,
): ViewTasksMessage {
  return {
    ...next,
    sourceSeqStart: Math.min(previous.sourceSeqStart, next.sourceSeqStart),
    sourceSeqEnd: Math.max(previous.sourceSeqEnd, next.sourceSeqEnd),
    startedAt: Math.min(getStartedAt(previous), getStartedAt(next)),
    createdAt: Math.max(previous.createdAt, next.createdAt),
  };
}

function compactTaskMessages(messages: ViewMessage[]): ViewMessage[] {
  const compacted: ViewMessage[] = [];

  for (const message of messages) {
    if (message.kind === "delegation") {
      compacted.push({
        ...message,
        children: compactTaskMessages(message.children),
      });
      continue;
    }

    const previous = compacted[compacted.length - 1];
    if (
      previous?.kind === "tasks" &&
      message.kind === "tasks" &&
      previous.source === message.source &&
      (previous.turnId ?? null) === (message.turnId ?? null) &&
      (previous.parentToolCallId ?? null) === (message.parentToolCallId ?? null)
    ) {
      compacted[compacted.length - 1] = mergeTaskMessages(previous, message);
      continue;
    }

    compacted.push(message);
  }

  return compacted;
}

function isDelegationCandidate(
  message: ViewMessage,
): message is ViewToolCallMessage {
  return (
    message.kind === "tool-call" &&
    isDelegationToolName(message.toolName)
  );
}

function toDelegationMessage(message: ViewToolCallMessage): ViewDelegationMessage {
  return {
    kind: "delegation",
    id: message.id,
    threadId: message.threadId,
    sourceSeqStart: message.sourceSeqStart,
    sourceSeqEnd: message.sourceSeqEnd,
    createdAt: message.createdAt,
    ...(message.startedAt ? { startedAt: message.startedAt } : {}),
    ...(message.turnId ? { turnId: message.turnId } : {}),
    ...(message.parentToolCallId ? { parentToolCallId: message.parentToolCallId } : {}),
    toolName: message.toolName,
    callId: message.callId,
    command: message.command,
    subagentType: message.subagentType,
    description: message.description,
    output: message.output,
    duration: message.duration,
    durationMs: message.durationMs,
    status: message.status,
    children: [],
  };
}

function sortIndexedMessages(messages: IndexedMessage[]): IndexedMessage[] {
  return [...messages].sort((left, right) => {
    if (left.message.sourceSeqStart !== right.message.sourceSeqStart) {
      return left.message.sourceSeqStart - right.message.sourceSeqStart;
    }
    if (left.message.createdAt !== right.message.createdAt) {
      return left.message.createdAt - right.message.createdAt;
    }
    return left.index - right.index;
  });
}

function finalizeDelegation(
  message: ViewDelegationMessage,
  indexLookup: Map<string, number>,
): IndexedMessage {
  const children = normalizeSemanticViewMessages(message.children).map((child) => ({
    message: child,
    index: indexLookup.get(child.id) ?? Number.MAX_SAFE_INTEGER,
  }));
  const sortedChildren = sortIndexedMessages(children).map((entry) => entry.message);

  if (sortedChildren.length === 0) {
    return {
      message,
      index: indexLookup.get(message.id) ?? Number.MAX_SAFE_INTEGER,
    };
  }

  const sourceSeqStart = Math.min(
    message.sourceSeqStart,
    ...sortedChildren.map((child) => child.sourceSeqStart),
  );
  const sourceSeqEnd = Math.max(
    message.sourceSeqEnd,
    ...sortedChildren.map((child) => child.sourceSeqEnd),
  );
  const startedAt = Math.min(
    getStartedAt(message),
    ...sortedChildren.map((child) => getStartedAt(child)),
  );
  const createdAt = Math.max(
    message.createdAt,
    ...sortedChildren.map((child) => child.createdAt),
  );

  return {
    message: {
      ...message,
      sourceSeqStart,
      sourceSeqEnd,
      startedAt,
      createdAt,
      children: sortedChildren,
    },
    index: indexLookup.get(message.id) ?? Number.MAX_SAFE_INTEGER,
  };
}

export function normalizeSemanticViewMessages(
  messages: ViewMessage[],
): ViewMessage[] {
  const compacted = compactTaskMessages(messages);
  const converted: IndexedMessage[] = compacted.map((message, index) => ({
    message: isDelegationCandidate(message)
      ? toDelegationMessage(message)
      : message,
    index,
  }));

  const indexLookup = new Map(converted.map((entry) => [entry.message.id, entry.index]));
  const delegationsByCallId = new Map<string, ViewDelegationMessage>();
  for (const entry of converted) {
    if (entry.message.kind === "delegation") {
      delegationsByCallId.set(entry.message.callId, entry.message);
    }
  }

  const attachedIds = new Set<string>();
  for (const entry of converted) {
    const parentToolCallId = entry.message.parentToolCallId;
    if (!parentToolCallId) continue;
    const parent = delegationsByCallId.get(parentToolCallId);
    if (!parent) continue;
    parent.children.push(entry.message);
    attachedIds.add(entry.message.id);
  }

  const roots = converted
    .filter((entry) => !attachedIds.has(entry.message.id))
    .map((entry) =>
      entry.message.kind === "delegation"
        ? finalizeDelegation(entry.message, indexLookup)
        : entry,
    );

  return sortIndexedMessages(roots).map((entry) => entry.message);
}
