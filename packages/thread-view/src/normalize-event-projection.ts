import { getProjectionEntryMessages } from "./event-projection-flatten.js";
import { isLegacyDelegationToolCall } from "@bb/domain";
import { getFirstStringField, messageId } from "./format-helpers.js";
import type {
  EventProjectionDelegationMessage,
  EventProjectionMessage,
  EventProjection,
  EventProjectionEntry,
  EventProjectionToolCallMessage,
  EventProjectionTurn,
} from "./event-projection-types.js";
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
  kind: "projected-message";
  entryIndex: number;
  message: EventProjectionMessage;
  messageIndex: number;
}

interface TurnMessageContext {
  kind: "turn";
  entryIndex: number;
  message: EventProjectionMessage;
  messageIndex: number;
  turn: EventProjectionTurn;
}

type SemanticMessageContext = StandaloneMessageContext | TurnMessageContext;

interface NormalizeEventProjectionOptions {
  contextOnlyToolCallIds?: ReadonlySet<string>;
}

function getStartedAt(message: MessageTimingSource): number {
  return message.startedAt ?? message.createdAt;
}

export function sortEventProjectionMessagesBySource(
  messages: EventProjectionMessage[],
): EventProjectionMessage[] {
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
  message: EventProjectionMessage,
): message is EventProjectionDelegationMessage {
  return message.kind === "delegation";
}

function toolCallAsDelegationMessage(
  message: EventProjectionToolCallMessage,
): EventProjectionDelegationMessage {
  const {
    kind: _kind,
    toolArgs,
    approvalStatus: _approvalStatus,
    ...shared
  } = message;
  const subagentType = getFirstStringField(toolArgs, [
    "subagent_type",
    "subagentType",
  ]);
  const description = getFirstStringField(toolArgs, ["description", "prompt"]);
  const model = getFirstStringField(toolArgs, ["model"]);
  return {
    ...shared,
    id: messageId(message.threadId, "delegation", message.callId),
    kind: "delegation",
    ...(subagentType ? { subagentType } : {}),
    ...(description ? { description } : {}),
    ...(model ? { model } : {}),
    childRef: null,
    background: false,
    childProjection: {
      state: {
        activeThinking: null,
        activeWorkflows: [],
        activeBackgroundCommands: [],
      },
      entries: [],
    },
  };
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
  message: EventProjectionDelegationMessage,
  childProjection: EventProjection,
): EventProjectionDelegationMessage {
  const resolvedChildProjection = mergeChildProjections(
    message.childProjection,
    childProjection,
  );
  const childBounds = getProjectionMessageBounds(resolvedChildProjection);
  const startedAt = maybeStartedAt(message, childBounds);
  const delegation: EventProjectionDelegationMessage = {
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
  existingProjection: EventProjection,
  discoveredProjection: EventProjection,
): EventProjection {
  if (existingProjection.entries.length === 0) {
    return discoveredProjection;
  }
  if (discoveredProjection.entries.length === 0) {
    return existingProjection;
  }

  const existingMessageIds = new Set(
    existingProjection.entries
      .flatMap((entry) => getProjectionEntryMessages(entry))
      .map((message) => message.id),
  );
  const discoveredEntries = discoveredProjection.entries.filter((entry) =>
    getProjectionEntryMessages(entry).some(
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

function getProjectionMessageBounds(
  projection: EventProjection,
): ProjectionMessageBounds | null {
  let bounds: ProjectionMessageBounds | null = null;
  for (const entry of projection.entries) {
    for (const message of getProjectionEntryMessages(entry)) {
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

function buildSourceTurn(
  sourceTurn: EventProjectionTurn,
  messages: EventProjectionMessage[],
): EventProjectionTurn {
  const terminalMessage = findLastTerminalTimelineMessage(messages);
  const turn: EventProjectionTurn = {
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
  projection: EventProjection,
): SemanticMessageContext[] {
  const contexts: SemanticMessageContext[] = [];
  let messageIndex = 0;

  projection.entries.forEach((entry, entryIndex) => {
    if (entry.kind === "projected-message") {
      contexts.push({
        kind: "projected-message",
        entryIndex,
        message: entry.message,
        messageIndex,
      });
      messageIndex += 1;
      return;
    }

    for (const message of getProjectionEntryMessages(entry)) {
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
  private readonly contextOnlyToolCallIds: ReadonlySet<string>;
  private readonly rootContexts: SemanticMessageContext[];

  constructor(
    contexts: SemanticMessageContext[],
    options: NormalizeEventProjectionOptions = {},
  ) {
    this.contextOnlyToolCallIds =
      options.contextOnlyToolCallIds ?? new Set<string>();
    const referencedParentCallIds = new Set(
      contexts
        .map((context) => context.message.parentToolCallId)
        .filter((id): id is string => id !== undefined),
    );
    for (const context of contexts) {
      if (
        context.message.kind === "tool-call" &&
        (referencedParentCallIds.has(context.message.callId) ||
          isLegacyDelegationToolCall({
            tool: context.message.toolName,
            presentation: context.message.presentation,
          }))
      ) {
        context.message = toolCallAsDelegationMessage(context.message);
      }
    }
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
      (context) =>
        !this.attachedMessageIds.has(context.message.id) &&
        !this.isRootSuppressedContext(context),
    );
  }

  private isContextOnlyToolCall(context: SemanticMessageContext): boolean {
    return (
      (context.message.kind === "delegation" ||
        context.message.kind === "tool-call") &&
      this.contextOnlyToolCallIds.has(context.message.callId)
    );
  }

  private isRootSuppressedContext(context: SemanticMessageContext): boolean {
    return (
      this.isContextOnlyToolCall(context) ||
      context.message.parentToolCallId !== undefined
    );
  }

  buildRootProjection(): EventProjection {
    return this.buildRootTurnProjection(this.rootContexts);
  }

  private buildRootTurnProjection(
    contexts: SemanticMessageContext[],
  ): EventProjection {
    const entries: EventProjectionEntry[] = [];
    let index = 0;

    while (index < contexts.length) {
      const context = contexts[index];
      if (!context) {
        break;
      }

      if (context.kind === "projected-message") {
        entries.push({
          kind: "projected-message",
          message: this.toSemanticMessage(context.message),
        });
        index += 1;
        continue;
      }

      const sourceTurn = context.turn;
      const messages: EventProjectionMessage[] = [];
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
        turn: buildSourceTurn(sourceTurn, messages),
      });
    }

    return {
      state: {
        activeThinking: null,
        activeWorkflows: [],
        activeBackgroundCommands: [],
      },
      entries,
    };
  }

  private buildFlatChildProjection(
    contexts: readonly SemanticMessageContext[],
  ): EventProjection {
    return {
      state: {
        activeThinking: null,
        activeWorkflows: [],
        activeBackgroundCommands: [],
      },
      entries: contexts.map((context) => ({
        kind: "projected-message",
        message: this.toSemanticMessage(context.message),
      })),
    };
  }

  private toSemanticMessage(
    message: EventProjectionMessage,
  ): EventProjectionMessage {
    if (!isDelegationSourceMessage(message)) {
      return message;
    }

    const childProjection = this.buildFlatChildProjection(
      this.childrenByParentCallId.get(message.callId) ?? [],
    );
    return toDelegationMessage(message, childProjection);
  }
}

export function normalizeEventProjection(
  projection: EventProjection,
  options: NormalizeEventProjectionOptions = {},
): EventProjection {
  const normalizedProjection = new SemanticProjectionBuilder(
    collectProjectionMessageContexts(projection),
    options,
  ).buildRootProjection();
  return {
    ...normalizedProjection,
    state: projection.state,
  };
}
