import type {
  ThreadEvent,
  ThreadEventItem,
  ThreadEventTokenUsageBreakdown,
} from "@bb/domain";
import { turnScope } from "@bb/domain";
import { withParentToolCallId } from "../shared/adapter-utils.js";
import type { AcceptedUserMessageState } from "../shared/accepted-user-messages.js";
import type {
  EnsureProviderTurnStartedArgs,
  ProviderTurnStateRegistry,
} from "../shared/turn-state.js";
import {
  getOrCreateScopedItemId,
  resolveCompletedScopedItemId,
} from "../shared/scoped-item-ids.js";
import { UNSTAMPED_THREAD_ID } from "../shared/unstamped-thread-id.js";
import type { ProviderTranslationContext } from "../provider-adapter.js";
import {
  claudeAssistantMessageSchema,
  claudeCompactBoundarySystemMessageSchema,
  claudeResultMessageSchema,
  claudeSdkMessageTypeSchema,
  claudeStatusSystemMessageSchema,
  claudeStreamEventMessageSchema,
  claudeSystemMessageSchema,
  claudeUserMessageSchema,
  type ClaudeToolUseResult,
} from "./schemas.js";
import {
  extractAssistantText,
  extractClaudeContextWindowUsage,
  extractClaudeRequestContextTokens,
  extractStreamTextDelta,
  extractStreamThinkingDelta,
  extractThinkingBlocks,
  extractTokenUsage,
  extractToolResults,
  extractToolUses,
  getNestedMessageId,
} from "./sdk-extraction.js";

export interface ClaudeTurnState {
  assistantMessageCounter: number;
  counter: number;
  currentTurnId: string | undefined;
  cumulativeTokens: ThreadEventTokenUsageBreakdown;
  latestRequestContextTokens: number | undefined;
  openAssistantMessageIdsByScope: Map<string, string>;
  openReasoningItemIdsByScope: Map<string, string>;
  pendingAcceptedUserMessages: AcceptedUserMessageState["pendingAcceptedUserMessages"];
  reasoningItemCounter: number;
  selectedModelContextWindow: number | null;
  toolItemsByCallId: Map<string, ThreadEventItem>;
}

export interface ClaudeToolUseTranslationInput {
  callId: string;
  toolName: string;
  args: unknown;
  parentToolCallId?: string;
}

export interface ClaudeToolResultTranslationInput {
  callId: string;
  toolName?: string;
  content: unknown;
  isError: boolean;
  parentToolCallId?: string;
  startedItem?: ThreadEventItem;
  toolUseResult: ClaudeToolUseResult | null;
}

export interface ClaudeUnexpectedSdkEventArgs {
  event: unknown;
  context?: ProviderTranslationContext;
  turnId?: string;
}

export interface TranslateClaudeSdkMessageArgs {
  buildUnexpectedSdkEvent: (
    args: ClaudeUnexpectedSdkEventArgs,
  ) => ThreadEvent[];
  context?: ProviderTranslationContext;
  ensureTurnStarted: (
    args: EnsureProviderTurnStartedArgs<ClaudeTurnState>,
  ) => string;
  event: unknown;
  translateToolResultItem: (
    input: ClaudeToolResultTranslationInput,
  ) => ThreadEventItem;
  translateToolUseItem: (input: ClaudeToolUseTranslationInput) => ThreadEventItem;
  turnState: ProviderTurnStateRegistry<ClaudeTurnState>;
}

interface ClaudeReasoningItemIdArgs {
  contentIndex: number;
  parentToolCallId?: string;
  state: ClaudeTurnState;
}

interface BuildClaudeCompactedEventArgs {
  threadId: string;
  turnId: string;
}

function buildClaudeCompactionItemId(turnId: string): string {
  return turnId.length > 0
    ? `claude-compaction-${turnId}`
    : "claude-compaction";
}

function createClaudeReasoningItemId(state: ClaudeTurnState): string {
  state.reasoningItemCounter += 1;
  return `claude-reasoning-${state.reasoningItemCounter}`;
}

function getOrCreateClaudeReasoningItemId(
  args: ClaudeReasoningItemIdArgs,
): string {
  return getOrCreateScopedItemId({
    createItemId: () => createClaudeReasoningItemId(args.state),
    openItemIdsByScope: args.state.openReasoningItemIdsByScope,
    parentToolCallId: args.parentToolCallId,
    scopeId: String(args.contentIndex),
  });
}

function resolveCompletedClaudeReasoningItemId(
  args: ClaudeReasoningItemIdArgs,
): string {
  return resolveCompletedScopedItemId({
    createItemId: () => createClaudeReasoningItemId(args.state),
    openItemIdsByScope: args.state.openReasoningItemIdsByScope,
    parentToolCallId: args.parentToolCallId,
    scopeId: String(args.contentIndex),
  });
}

function buildClaudeCompactedEvent(
  args: BuildClaudeCompactedEventArgs,
): ThreadEvent {
  return {
    type: "thread/compacted",
    threadId: args.threadId,
    providerThreadId: "",
    scope: turnScope(args.turnId),
  };
}

function resolveClaudeActiveTurnId(
  args: Pick<TranslateClaudeSdkMessageArgs, "context" | "turnState">,
): string | undefined {
  if (!args.context?.threadId) {
    return undefined;
  }
  return args.turnState.get({ threadId: args.context.threadId })?.currentTurnId;
}

export function translateClaudeSdkMessage(
  args: TranslateClaudeSdkMessageArgs,
): ThreadEvent[] {
  const messageType = claudeSdkMessageTypeSchema.safeParse(args.event);
  if (!messageType.success) {
    return [];
  }

  const threadId = UNSTAMPED_THREAD_ID;
  const events: ThreadEvent[] = [];
  const stateKey = args.context?.threadId ?? "";
  const state = args.turnState.getOrCreate({ threadId: stateKey });
  const parentToolCallId = args.context?.parentToolCallId;
  const fallbackTurnId = resolveClaudeActiveTurnId(args);

  switch (messageType.data.type) {
    case "system": {
      const parsedMessage = claudeSystemMessageSchema.safeParse(args.event);
      if (!parsedMessage.success) {
        return args.buildUnexpectedSdkEvent({
          event: args.event,
          context: args.context,
          turnId: fallbackTurnId,
        });
      }
      const statusMessage = claudeStatusSystemMessageSchema.safeParse(
        args.event,
      );
      if (
        statusMessage.success &&
        statusMessage.data.status === "compacting"
      ) {
        const turnId = args.ensureTurnStarted({
          events,
          state,
          threadId,
        });
        events.push({
          type: "item/started",
          threadId,
          providerThreadId: "",
          scope: turnScope(turnId),
          item: {
            type: "contextCompaction",
            id: buildClaudeCompactionItemId(turnId),
          },
        });
        return events;
      }

      const compactBoundaryMessage =
        claudeCompactBoundarySystemMessageSchema.safeParse(args.event);
      if (compactBoundaryMessage.success) {
        const turnId = args.turnState.getCurrentOrLastTurnId({ state });
        if (turnId.length === 0) {
          return args.buildUnexpectedSdkEvent({
            event: args.event,
            context: args.context,
            turnId: fallbackTurnId,
          });
        }
        events.push(buildClaudeCompactedEvent({ threadId, turnId }));
        return events;
      }

      return [];
    }

    case "assistant": {
      const parsedMessage = claudeAssistantMessageSchema.safeParse(args.event);
      if (!parsedMessage.success) {
        return args.buildUnexpectedSdkEvent({
          event: args.event,
          context: args.context,
          turnId: fallbackTurnId,
        });
      }
      const message = parsedMessage.data;
      const turnId = args.ensureTurnStarted({
        events,
        state,
        threadId,
      });
      const requestContextTokens = extractClaudeRequestContextTokens(message);
      if (requestContextTokens !== null) {
        state.latestRequestContextTokens = requestContextTokens;
      }
      const assistantMessageId = getNestedMessageId(message.message);

      const thinkingBlocks = extractThinkingBlocks(message);
      for (const thinkingBlock of thinkingBlocks) {
        const itemId = resolveCompletedClaudeReasoningItemId({
          state,
          parentToolCallId,
          contentIndex: thinkingBlock.contentIndex,
        });
        events.push({
          type: "item/completed",
          threadId,
          providerThreadId: "",
          scope: turnScope(turnId),
          item: withParentToolCallId(
            {
              type: "reasoning",
              id: itemId,
              summary: [],
              content: [thinkingBlock.text],
            },
            parentToolCallId,
          ),
        });
      }

      const text = extractAssistantText(message);
      if (text) {
        const itemId = args.turnState.resolveCompletedAssistantMessageId({
          assistantIdPrefix: "claude-assistant",
          state,
          parentToolCallId,
          providerMessageId: assistantMessageId,
        });
        events.push({
          type: "item/completed",
          threadId,
          providerThreadId: "",
          scope: turnScope(turnId),
          item: {
            type: "agentMessage",
            id: itemId,
            text,
            ...(parentToolCallId ? { parentToolCallId } : {}),
          },
        });
      }

      const toolUses = extractToolUses(message);
      for (const toolUse of toolUses) {
        const item = args.translateToolUseItem({
          callId: toolUse.id,
          toolName: toolUse.name,
          args: toolUse.input,
          parentToolCallId,
        });
        state.toolItemsByCallId.set(toolUse.id, item);
        events.push({
          type: "item/started",
          threadId,
          providerThreadId: "",
          scope: turnScope(turnId),
          item,
        });
      }
      break;
    }

    case "stream_event": {
      const parsedMessage = claudeStreamEventMessageSchema.safeParse(
        args.event,
      );
      if (!parsedMessage.success) {
        return args.buildUnexpectedSdkEvent({
          event: args.event,
          context: args.context,
          turnId: fallbackTurnId,
        });
      }
      const message = parsedMessage.data;
      const reasoningDelta = extractStreamThinkingDelta(message);
      if (reasoningDelta) {
        const turnId = args.ensureTurnStarted({
          events,
          state,
          threadId,
        });
        const itemId = getOrCreateClaudeReasoningItemId({
          state,
          parentToolCallId,
          contentIndex: reasoningDelta.contentIndex,
        });
        events.push({
          type: "item/reasoning/textDelta",
          threadId,
          providerThreadId: "",
          scope: turnScope(turnId),
          itemId,
          delta: reasoningDelta.delta,
          ...(parentToolCallId ? { parentToolCallId } : {}),
        });
      }

      const textDelta = extractStreamTextDelta(message);
      if (textDelta) {
        const turnId = args.ensureTurnStarted({
          events,
          state,
          threadId,
        });
        const itemId = args.turnState.getOrCreateAssistantMessageId({
          assistantIdPrefix: "claude-assistant",
          parentToolCallId,
          state,
        });
        events.push({
          type: "item/agentMessage/delta",
          threadId,
          providerThreadId: "",
          scope: turnScope(turnId),
          itemId,
          delta: textDelta.delta,
          ...(parentToolCallId ? { parentToolCallId } : {}),
        });
      }
      break;
    }

    case "user": {
      const parsedMessage = claudeUserMessageSchema.safeParse(args.event);
      if (!parsedMessage.success) {
        return args.buildUnexpectedSdkEvent({
          event: args.event,
          context: args.context,
          turnId: fallbackTurnId,
        });
      }
      const message = parsedMessage.data;
      const toolResults = extractToolResults(message);
      if (toolResults.length === 0) {
        break;
      }
      const toolResultTurnId = state.currentTurnId;
      if (!toolResultTurnId) {
        return args.buildUnexpectedSdkEvent({
          event: args.event,
          context: args.context,
          turnId: fallbackTurnId,
        });
      }
      for (const result of toolResults) {
        const startedItem = state.toolItemsByCallId.get(result.toolUseId);
        events.push({
          type: "item/completed",
          threadId,
          providerThreadId: "",
          scope: turnScope(toolResultTurnId),
          item: args.translateToolResultItem({
            callId: result.toolUseId,
            content: result.content,
            isError: result.isError,
            toolName: result.toolName,
            toolUseResult: result.toolUseResult,
            startedItem,
            parentToolCallId,
          }),
        });
        state.toolItemsByCallId.delete(result.toolUseId);
      }
      break;
    }

    case "result": {
      const parsedMessage = claudeResultMessageSchema.safeParse(args.event);
      if (!parsedMessage.success) {
        return args.buildUnexpectedSdkEvent({
          event: args.event,
          context: args.context,
          turnId: fallbackTurnId,
        });
      }
      const message = parsedMessage.data;
      if (state.currentTurnId) {
        const resultErrorText =
          message.is_error &&
          "result" in message &&
          typeof message.result === "string"
            ? message.result
            : null;
        const contextWindowUsage = extractClaudeContextWindowUsage({
          fallbackModelContextWindow: state.selectedModelContextWindow,
          latestRequestContextTokens: state.latestRequestContextTokens,
          message,
        });
        if (
          contextWindowUsage !== undefined &&
          contextWindowUsage.modelContextWindow !== null
        ) {
          state.selectedModelContextWindow =
            contextWindowUsage.modelContextWindow;
        }
        const tokenUsage = extractTokenUsage(message, state.cumulativeTokens);
        if (contextWindowUsage) {
          events.push({
            type: "thread/contextWindowUsage/updated",
            threadId,
            providerThreadId: "",
            scope: turnScope(state.currentTurnId),
            contextWindowUsage,
          });
        }
        if (tokenUsage) {
          events.push({
            type: "thread/tokenUsage/updated",
            threadId,
            providerThreadId: "",
            scope: turnScope(state.currentTurnId),
            tokenUsage,
          });
        }
        if (resultErrorText) {
          events.push({
            type: "provider/error",
            threadId,
            providerThreadId: "",
            scope: turnScope(state.currentTurnId),
            message: "Provider error",
            detail: resultErrorText,
          });
        }
        events.push({
          type: "turn/completed",
          threadId,
          providerThreadId: "",
          scope: turnScope(state.currentTurnId),
          status:
            message.is_error || message.subtype.startsWith("error")
              ? "failed"
              : "completed",
        });
        args.turnState.finishTurn({ state, threadId: stateKey });
      }
      break;
    }

    case "rate_limit_event":
      return [];
  }

  return events;
}
