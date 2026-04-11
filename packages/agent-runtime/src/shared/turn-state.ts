import type {
  ThreadEvent,
  ThreadEventItem,
  ThreadEventTokenUsageBreakdown,
} from "@bb/domain";
import {
  getOrCreateScopedItemId,
  resolveCompletedScopedItemId,
} from "./scoped-item-ids.js";

const DEFAULT_PROVIDER_TURN_STATE_MAX_ENTRIES = 256;
const DEFAULT_PROVIDER_TURN_ID_PREFIX = "turn-";

export interface ProviderTurnState {
  assistantMessageCounter: number;
  counter: number;
  currentTurnId: string | undefined;
  cumulativeTokens: ThreadEventTokenUsageBreakdown;
  openAssistantMessageIdsByScope: Map<string, string>;
  openReasoningItemIdsByScope: Map<string, string>;
  toolItemsByCallId: Map<string, ThreadEventItem>;
}

export interface CreateProviderTurnStateRegistryOptions<TState extends ProviderTurnState> {
  createState: () => TState;
  maxEntries?: number;
  turnIdPrefix?: string;
}

export interface ProviderTurnStateRegistry<TState extends ProviderTurnState> {
  ensureTurnStarted(args: EnsureProviderTurnStartedArgs<TState>): string;
  finishTurn(args: FinishProviderTurnArgs<TState>): void;
  getCurrentOrLastTurnId(args: GetCurrentOrLastProviderTurnIdArgs<TState>): string;
  getOrCreate(args: GetProviderTurnStateArgs): TState;
  getOrCreateAssistantMessageId(args: GetOrCreateAssistantMessageIdArgs<TState>): string;
  resolveCompletedAssistantMessageId(
    args: ResolveCompletedAssistantMessageIdArgs<TState>,
  ): string;
}

export interface EnsureProviderTurnStartedArgs<TState extends ProviderTurnState> {
  events: ThreadEvent[];
  state: TState;
  threadId: string;
}

export interface FinishProviderTurnArgs<TState extends ProviderTurnState> {
  state: TState;
  threadId: string;
}

export interface GetProviderTurnStateArgs {
  threadId: string;
}

export interface GetCurrentOrLastProviderTurnIdArgs<TState extends ProviderTurnState> {
  state: TState;
}

export interface GetOrCreateAssistantMessageIdArgs<TState extends ProviderTurnState> {
  assistantIdPrefix: string;
  parentToolCallId?: string;
  state: TState;
}

export interface ResolveCompletedAssistantMessageIdArgs<TState extends ProviderTurnState> {
  assistantIdPrefix: string;
  parentToolCallId?: string;
  providerMessageId?: string;
  state: TState;
}

interface ProviderTurnStateRegistryEntry<TState extends ProviderTurnState> {
  state: TState;
}

export function createProviderTurnStateRegistry<TState extends ProviderTurnState>(
  options: CreateProviderTurnStateRegistryOptions<TState>,
): ProviderTurnStateRegistry<TState> {
  const entries = new Map<string, ProviderTurnStateRegistryEntry<TState>>();
  const maxEntries =
    options.maxEntries ?? DEFAULT_PROVIDER_TURN_STATE_MAX_ENTRIES;
  const turnIdPrefix = options.turnIdPrefix ?? DEFAULT_PROVIDER_TURN_ID_PREFIX;

  function createTurnId(counter: number): string {
    return `${turnIdPrefix}${counter}`;
  }

  function clearTransientTurnState(state: TState): void {
    state.openAssistantMessageIdsByScope.clear();
    state.openReasoningItemIdsByScope.clear();
    state.toolItemsByCallId.clear();
  }

  function touchEntry(args: GetProviderTurnStateArgs): ProviderTurnStateRegistryEntry<TState> | undefined {
    const existing = entries.get(args.threadId);
    if (!existing) {
      return undefined;
    }
    entries.delete(args.threadId);
    entries.set(args.threadId, existing);
    return existing;
  }

  function pruneInactiveEntries(): void {
    while (entries.size > maxEntries) {
      let removed = false;
      for (const [threadId, entry] of entries) {
        if (entry.state.currentTurnId !== undefined) {
          continue;
        }
        entries.delete(threadId);
        removed = true;
        break;
      }
      if (!removed) {
        return;
      }
    }
  }

  function createAssistantMessageId(args: GetOrCreateAssistantMessageIdArgs<TState>): string {
    args.state.assistantMessageCounter += 1;
    return `${args.assistantIdPrefix}-${args.state.assistantMessageCounter}`;
  }

  return {
    ensureTurnStarted(args) {
      if (!args.state.currentTurnId) {
        clearTransientTurnState(args.state);
        args.state.counter += 1;
        args.state.currentTurnId = createTurnId(args.state.counter);
        args.events.push({
          type: "turn/started",
          threadId: args.threadId,
          providerThreadId: "",
          turnId: args.state.currentTurnId,
        });
      }
      return args.state.currentTurnId;
    },

    finishTurn(args) {
      clearTransientTurnState(args.state);
      args.state.currentTurnId = undefined;
      touchEntry({ threadId: args.threadId });
      pruneInactiveEntries();
    },

    getCurrentOrLastTurnId(args) {
      return args.state.currentTurnId ?? (
        args.state.counter > 0
          ? createTurnId(args.state.counter)
          : ""
      );
    },

    getOrCreate(args) {
      const existing = touchEntry(args);
      if (existing) {
        return existing.state;
      }

      const entry: ProviderTurnStateRegistryEntry<TState> = {
        state: options.createState(),
      };
      entries.set(args.threadId, entry);
      pruneInactiveEntries();
      return entry.state;
    },

    getOrCreateAssistantMessageId(args) {
      return getOrCreateScopedItemId({
        createItemId: () => createAssistantMessageId(args),
        openItemIdsByScope: args.state.openAssistantMessageIdsByScope,
        parentToolCallId: args.parentToolCallId,
        scopeId: "assistant",
      });
    },

    resolveCompletedAssistantMessageId(args) {
      return resolveCompletedScopedItemId({
        createItemId: () => createAssistantMessageId(args),
        openItemIdsByScope: args.state.openAssistantMessageIdsByScope,
        parentToolCallId: args.parentToolCallId,
        providerItemId: args.providerMessageId,
        scopeId: "assistant",
      });
    },
  };
}
