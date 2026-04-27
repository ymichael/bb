import type { ThreadEvent } from "@bb/domain";
import { threadScope, turnScope } from "@bb/domain";
import type {
  EnsureProviderTurnStartedArgs,
  ProviderTurnState,
  ProviderTurnStateRegistry,
} from "./turn-state.js";
import { UNSTAMPED_THREAD_ID } from "./unstamped-thread-id.js";

export interface BuildScopedProviderErrorEventsArgs<
  TState extends ProviderTurnState,
> {
  contextThreadId?: string;
  detail: string;
  ensureTurnStarted: (args: EnsureProviderTurnStartedArgs<TState>) => string;
  registry: ProviderTurnStateRegistry<TState>;
}

export function buildScopedProviderErrorEvents<
  TState extends ProviderTurnState,
>(args: BuildScopedProviderErrorEventsArgs<TState>): ThreadEvent[] {
  const events: ThreadEvent[] = [];
  const stateKey = args.contextThreadId;
  const state = stateKey
    ? args.registry.getOrCreate({ threadId: stateKey })
    : null;
  const turnId = state
    ? args.ensureTurnStarted({
        events,
        state,
        threadId: UNSTAMPED_THREAD_ID,
      })
    : undefined;

  events.push({
    type: "provider/error",
    threadId: UNSTAMPED_THREAD_ID,
    providerThreadId: "",
    scope: turnId ? turnScope(turnId) : threadScope(),
    message: "Provider error",
    detail: args.detail,
  });

  if (stateKey && state && turnId) {
    events.push({
      type: "turn/completed",
      threadId: UNSTAMPED_THREAD_ID,
      providerThreadId: "",
      scope: turnScope(turnId),
      status: "failed",
    });
    args.registry.finishTurn({ state, threadId: stateKey });
  }

  return events;
}
