import type {
  ViewDelegationMessage,
  ViewMessage,
  ViewMessageStatus,
  ViewProjection,
  ViewTimelineEntry,
  ViewTurn,
  ViewTurnStatus,
} from "@bb/domain";
import { findLastTerminalTimelineMessage } from "./timeline-message-helpers.js";
import { getProjectionSummaryCount } from "./apply-turn-message-detail.js";

interface MessageTimingSource {
  createdAt: number;
  startedAt?: number;
}

interface ProjectionMessageBounds {
  createdAt: number;
  sourceSeqEnd: number;
  sourceSeqStart: number;
  startedAt: number;
}

interface StandaloneMessageContext {
  kind: "message";
  entryIndex: number;
  message: ViewMessage;
  messageIndex: number;
}

interface TurnMessageContext {
  kind: "turn";
  entryIndex: number;
  message: ViewMessage;
  messageIndex: number;
  turn: ViewTurn;
}

type SemanticMessageContext = StandaloneMessageContext | TurnMessageContext;
type TurnMetadataMode = "source" | "scoped";

function getStartedAt(message: MessageTimingSource): number {
  return message.startedAt ?? message.createdAt;
}

export function sortViewMessagesBySource(
  messages: ViewMessage[],
): ViewMessage[] {
  return messages
    .map((message, index) => ({ index, message }))
    .sort((left, right) => {
      if (left.message.sourceSeqStart !== right.message.sourceSeqStart) {
        return left.message.sourceSeqStart - right.message.sourceSeqStart;
      }
      if (left.message.createdAt !== right.message.createdAt) {
        return left.message.createdAt - right.message.createdAt;
      }
      return left.index - right.index;
    })
    .map((entry) => entry.message);
}

function isDelegationSourceMessage(
  message: ViewMessage,
): message is ViewDelegationMessage {
  return message.kind === "delegation";
}

function maybeStartedAt(
  message: MessageTimingSource,
  childBounds: ProjectionMessageBounds | null,
): number | undefined {
  if (childBounds) {
    return Math.min(getStartedAt(message), childBounds.startedAt);
  }
  return message.startedAt;
}

function toDelegationMessage(
  message: ViewDelegationMessage,
  childProjection: ViewProjection,
): ViewDelegationMessage {
  const resolvedChildProjection = mergeChildProjections(
    message.childProjection,
    childProjection,
  );
  const childBounds = getProjectionMessageBounds(resolvedChildProjection);
  const startedAt = maybeStartedAt(message, childBounds);
  const delegation: ViewDelegationMessage = {
    ...message,
    sourceSeqStart: childBounds
      ? Math.min(message.sourceSeqStart, childBounds.sourceSeqStart)
      : message.sourceSeqStart,
    sourceSeqEnd: childBounds
      ? Math.max(message.sourceSeqEnd, childBounds.sourceSeqEnd)
      : message.sourceSeqEnd,
    createdAt: childBounds
      ? Math.max(message.createdAt, childBounds.createdAt)
      : message.createdAt,
    childProjection: resolvedChildProjection,
  };
  if (startedAt !== undefined) {
    delegation.startedAt = startedAt;
  }
  if (message.parentToolCallId) {
    delegation.parentToolCallId = message.parentToolCallId;
  }
  return delegation;
}

function mergeChildProjections(
  existingProjection: ViewProjection,
  discoveredProjection: ViewProjection,
): ViewProjection {
  if (existingProjection.entries.length === 0) {
    return discoveredProjection;
  }
  if (discoveredProjection.entries.length === 0) {
    return existingProjection;
  }

  const existingMessageIds = new Set(
    existingProjection.entries
      .flatMap((entry) => getEntryMessages(entry))
      .map((message) => message.id),
  );
  const discoveredEntries = discoveredProjection.entries.filter((entry) =>
    getEntryMessages(entry).some(
      (message) => !existingMessageIds.has(message.id),
    ),
  );

  if (discoveredEntries.length === 0) {
    return existingProjection;
  }

  return {
    state: existingProjection.state,
    entries: [...existingProjection.entries, ...discoveredEntries],
  };
}

function getEntryMessages(entry: ViewTimelineEntry): readonly ViewMessage[] {
  if (entry.kind === "message") {
    return [entry.message];
  }
  if (entry.turn.messages) {
    return entry.turn.messages;
  }
  if (entry.turn.terminalMessage) {
    return [entry.turn.terminalMessage];
  }
  return [];
}

function getProjectionMessageBounds(
  projection: ViewProjection,
): ProjectionMessageBounds | null {
  let bounds: ProjectionMessageBounds | null = null;
  for (const entry of projection.entries) {
    for (const message of getEntryMessages(entry)) {
      const startedAt = getStartedAt(message);
      bounds = bounds
        ? {
            sourceSeqStart: Math.min(
              bounds.sourceSeqStart,
              message.sourceSeqStart,
            ),
            sourceSeqEnd: Math.max(bounds.sourceSeqEnd, message.sourceSeqEnd),
            startedAt: Math.min(bounds.startedAt, startedAt),
            createdAt: Math.max(bounds.createdAt, message.createdAt),
          }
        : {
            sourceSeqStart: message.sourceSeqStart,
            sourceSeqEnd: message.sourceSeqEnd,
            startedAt,
            createdAt: message.createdAt,
          };
    }
  }
  return bounds;
}

function getMessageStatus(message: ViewMessage): ViewMessageStatus {
  switch (message.kind) {
    case "assistant-text":
    case "command":
    case "tool-call":
    case "web-search":
    case "web-fetch":
    case "file-edit":
    case "delegation":
    case "permission-grant-lifecycle":
      return message.status;
    case "operation":
      return message.status ?? "completed";
    case "error":
      return "error";
    case "user":
    case "debug/raw-event":
      return "completed";
  }
}

function getScopedTurnStatus(messages: ViewMessage[]): ViewTurnStatus {
  const statuses = messages.map((message) => getMessageStatus(message));
  if (statuses.includes("error")) {
    return "error";
  }
  if (statuses.includes("pending") || statuses.includes("streaming")) {
    return "pending";
  }
  if (statuses.includes("interrupted")) {
    return "interrupted";
  }
  return "completed";
}

function getDurationMs(
  startedAt: number,
  completedAt: number | null,
): number | undefined {
  if (completedAt === null) {
    return undefined;
  }
  return Math.max(0, completedAt - startedAt);
}

function buildScopedTurn(
  sourceTurn: ViewTurn,
  messages: ViewMessage[],
): ViewTurn {
  const firstMessage = messages[0];
  if (!firstMessage) {
    throw new Error(
      `Cannot build scoped projection turn ${sourceTurn.turnId} without messages`,
    );
  }

  const sourceSeqStart = Math.min(
    ...messages.map((message) => message.sourceSeqStart),
  );
  const sourceSeqEnd = Math.max(
    ...messages.map((message) => message.sourceSeqEnd),
  );
  const startedAt = Math.min(
    ...messages.map((message) => getStartedAt(message)),
  );
  const createdAt = Math.max(...messages.map((message) => message.createdAt));
  const status = getScopedTurnStatus(messages);
  const completedAt = status === "pending" ? null : createdAt;
  const terminalMessage = findLastTerminalTimelineMessage(messages);
  const turn: ViewTurn = {
    turnId: sourceTurn.turnId,
    threadId: firstMessage.threadId,
    sourceSeqStart,
    sourceSeqEnd,
    startedAt,
    createdAt,
    completedAt,
    status,
    summaryCount: getProjectionSummaryCount(messages, terminalMessage),
    messages,
  };

  if (terminalMessage) {
    turn.terminalMessage = terminalMessage;
  }
  const durationMs = getDurationMs(startedAt, completedAt);
  if (durationMs !== undefined) {
    turn.durationMs = durationMs;
  }
  return turn;
}

function buildSourceTurn(
  sourceTurn: ViewTurn,
  messages: ViewMessage[],
): ViewTurn {
  const terminalMessage = findLastTerminalTimelineMessage(messages);
  const turn: ViewTurn = {
    ...sourceTurn,
    summaryCount: getProjectionSummaryCount(messages, terminalMessage),
    messages,
  };
  delete turn.terminalMessage;
  if (terminalMessage) {
    turn.terminalMessage = terminalMessage;
  }
  return turn;
}

function collectProjectionMessageContexts(
  projection: ViewProjection,
): SemanticMessageContext[] {
  const contexts: SemanticMessageContext[] = [];
  let messageIndex = 0;

  projection.entries.forEach((entry, entryIndex) => {
    if (entry.kind === "message") {
      contexts.push({
        kind: "message",
        entryIndex,
        message: entry.message,
        messageIndex,
      });
      messageIndex += 1;
      return;
    }

    for (const message of getEntryMessages(entry)) {
      contexts.push({
        kind: "turn",
        entryIndex,
        message,
        messageIndex,
        turn: entry.turn,
      });
      messageIndex += 1;
    }
  });

  return contexts;
}

function collectFlatMessageContexts(
  messages: ViewMessage[],
): SemanticMessageContext[] {
  return messages.map((message, index) => ({
    kind: "message",
    entryIndex: index,
    message,
    messageIndex: index,
  }));
}

function isSameTurnEntry(
  left: SemanticMessageContext,
  right: SemanticMessageContext,
): right is TurnMessageContext {
  return (
    left.kind === "turn" &&
    right.kind === "turn" &&
    left.entryIndex === right.entryIndex
  );
}

class SemanticProjectionBuilder {
  private readonly attachedMessageIds = new Set<string>();
  private readonly childrenByParentCallId = new Map<
    string,
    SemanticMessageContext[]
  >();
  private readonly rootContexts: SemanticMessageContext[];

  constructor(contexts: SemanticMessageContext[]) {
    const delegationCallIds = new Set(
      contexts
        .map((context) => context.message)
        .filter(isDelegationSourceMessage)
        .map((message) => message.callId),
    );

    for (const context of contexts) {
      const parentToolCallId = context.message.parentToolCallId;
      if (!parentToolCallId || !delegationCallIds.has(parentToolCallId)) {
        continue;
      }

      const children = this.childrenByParentCallId.get(parentToolCallId) ?? [];
      children.push(context);
      this.childrenByParentCallId.set(parentToolCallId, children);
      this.attachedMessageIds.add(context.message.id);
    }

    this.rootContexts = contexts.filter(
      (context) => !this.attachedMessageIds.has(context.message.id),
    );
  }

  buildRootProjection(): ViewProjection {
    return this.buildProjection(this.rootContexts, "source");
  }

  buildRootMessages(): ViewMessage[] {
    return this.rootContexts.map((context) =>
      this.toSemanticMessage(context.message),
    );
  }

  private buildProjection(
    contexts: SemanticMessageContext[],
    turnMetadataMode: TurnMetadataMode,
  ): ViewProjection {
    const entries: ViewTimelineEntry[] = [];
    let index = 0;

    while (index < contexts.length) {
      const context = contexts[index];
      if (!context) {
        break;
      }

      if (context.kind === "message") {
        entries.push({
          kind: "message",
          message: this.toSemanticMessage(context.message),
        });
        index += 1;
        continue;
      }

      const sourceTurn = context.turn;
      const messages: ViewMessage[] = [];
      messages.push(this.toSemanticMessage(context.message));
      index += 1;

      while (index < contexts.length) {
        const nextContext = contexts[index];
        if (!nextContext || !isSameTurnEntry(context, nextContext)) {
          break;
        }
        messages.push(this.toSemanticMessage(nextContext.message));
        index += 1;
      }

      entries.push({
        kind: "turn",
        turn:
          turnMetadataMode === "source"
            ? buildSourceTurn(sourceTurn, messages)
            : buildScopedTurn(sourceTurn, messages),
      });
    }

    return {
      state: {
        activeThinking: null,
      },
      entries,
    };
  }

  private toSemanticMessage(message: ViewMessage): ViewMessage {
    if (!isDelegationSourceMessage(message)) {
      return message;
    }

    const childProjection = this.buildProjection(
      this.childrenByParentCallId.get(message.callId) ?? [],
      "scoped",
    );
    return toDelegationMessage(message, childProjection);
  }
}

export function normalizeSemanticViewProjection(
  projection: ViewProjection,
): ViewProjection {
  const normalizedProjection = new SemanticProjectionBuilder(
    collectProjectionMessageContexts(projection),
  ).buildRootProjection();
  return {
    ...normalizedProjection,
    state: projection.state,
  };
}

export function normalizeSemanticViewMessages(
  messages: ViewMessage[],
): ViewMessage[] {
  const orderedMessages = sortViewMessagesBySource(messages);
  return new SemanticProjectionBuilder(
    collectFlatMessageContexts(orderedMessages),
  ).buildRootMessages();
}
