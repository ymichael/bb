import type { ThreadEvent } from "@bb/domain";
import { getThreadEventScopeTurnId } from "@bb/domain";

export const ITEM_STREAMING_EVENT_TYPES = new Set<ThreadEvent["type"]>([
  "item/agentMessage/delta",
  "item/plan/delta",
  "item/commandExecution/outputDelta",
  "item/fileChange/outputDelta",
  "item/reasoning/summaryTextDelta",
  "item/reasoning/textDelta",
  "item/mcpToolCall/progress",
  "item/toolCall/progress",
]);

const MAX_ITEM_IDS_PER_THREAD = 512;

export const THREAD_EVENT_GRAMMAR_RULES = {
  itemOpensBeforeDelta: "item/opens-before-delta",
  itemSettlesOnce: "item/settles-once",
  turnStartsOnce: "turn/starts-once",
  turnSettlesOnce: "turn/settles-once",
  turnKnown: "turn/known",
} as const;

export type ThreadEventGrammarRule =
  (typeof THREAD_EVENT_GRAMMAR_RULES)[keyof typeof THREAD_EVENT_GRAMMAR_RULES];

export type ThreadEventGrammarResult =
  | { kind: "ok" }
  | { kind: "violation"; rule: ThreadEventGrammarRule; reason: string };

const OK: ThreadEventGrammarResult = { kind: "ok" };

interface ThreadGrammarState {
  openItemIds: Set<string>;
  settledItemIds: Set<string>;
  startedTurnIds: Set<string>;
  completedTurnIds: Set<string>;
}

export class ThreadEventGrammar {
  readonly #byThreadId = new Map<string, ThreadGrammarState>();

  clear(): void {
    this.#byThreadId.clear();
  }

  clearThread(threadId: string): void {
    this.#byThreadId.delete(threadId);
  }

  observe(event: ThreadEvent): ThreadEventGrammarResult {
    const state = this.#stateFor(event.threadId);
    switch (event.type) {
      case "turn/started": {
        const turnId = turnIdOf(event);
        if (turnId === undefined) {
          return OK;
        }
        if (state.completedTurnIds.has(turnId)) {
          return violation(
            THREAD_EVENT_GRAMMAR_RULES.turnStartsOnce,
            `turn/started for turn "${turnId}", which already completed`,
          );
        }
        if (state.startedTurnIds.has(turnId)) {
          return violation(
            THREAD_EVENT_GRAMMAR_RULES.turnStartsOnce,
            `turn/started for turn "${turnId}", which is already open`,
          );
        }
        state.startedTurnIds.add(turnId);
        return OK;
      }
      case "turn/completed": {
        const turnId = turnIdOf(event);
        if (turnId === undefined) {
          return OK;
        }
        if (state.completedTurnIds.has(turnId)) {
          return violation(
            THREAD_EVENT_GRAMMAR_RULES.turnSettlesOnce,
            `turn/completed for turn "${turnId}", which already completed`,
          );
        }
        if (!state.startedTurnIds.has(turnId)) {
          return violation(
            THREAD_EVENT_GRAMMAR_RULES.turnKnown,
            `turn/completed for turn "${turnId}", which never started`,
          );
        }
        state.startedTurnIds.delete(turnId);
        state.completedTurnIds.add(turnId);
        return OK;
      }
      case "item/started": {
        state.openItemIds.add(event.item.id);
        state.settledItemIds.delete(event.item.id);
        trim(state.openItemIds);
        return OK;
      }
      case "item/completed":
      case "item/backgroundTask/completed":
      case "item/delegation/completed": {
        const itemId = event.item.id;
        if (state.settledItemIds.has(itemId)) {
          return violation(
            THREAD_EVENT_GRAMMAR_RULES.itemSettlesOnce,
            `${event.type} for item "${itemId}", which already settled`,
          );
        }
        state.openItemIds.delete(itemId);
        state.settledItemIds.add(itemId);
        trim(state.settledItemIds);
        return OK;
      }
      case "item/backgroundTask/progress":
      case "item/delegation/progress": {
        return this.#checkOpenItem(state, event.type, event.item.id);
      }
      default: {
        if (!ITEM_STREAMING_EVENT_TYPES.has(event.type)) {
          return OK;
        }
        if (!("itemId" in event) || typeof event.itemId !== "string") {
          return OK;
        }
        return this.#checkOpenItem(state, event.type, event.itemId);
      }
    }
  }

  #checkOpenItem(
    state: ThreadGrammarState,
    eventType: string,
    itemId: string,
  ): ThreadEventGrammarResult {
    if (state.openItemIds.has(itemId)) {
      return OK;
    }
    return violation(
      THREAD_EVENT_GRAMMAR_RULES.itemOpensBeforeDelta,
      `${eventType} for item "${itemId}" arrived before item/started`,
    );
  }

  #stateFor(threadId: string): ThreadGrammarState {
    const existing = this.#byThreadId.get(threadId);
    if (existing !== undefined) {
      return existing;
    }
    const created: ThreadGrammarState = {
      openItemIds: new Set(),
      settledItemIds: new Set(),
      startedTurnIds: new Set(),
      completedTurnIds: new Set(),
    };
    this.#byThreadId.set(threadId, created);
    return created;
  }
}

function violation(
  rule: ThreadEventGrammarRule,
  reason: string,
): ThreadEventGrammarResult {
  return { kind: "violation", rule, reason };
}

function turnIdOf(event: ThreadEvent): string | undefined {
  return "scope" in event ? getThreadEventScopeTurnId(event.scope) : undefined;
}

function trim(itemIds: Set<string>): void {
  while (itemIds.size > MAX_ITEM_IDS_PER_THREAD) {
    const oldest = itemIds.values().next();
    if (oldest.done === true) {
      return;
    }
    itemIds.delete(oldest.value);
  }
}
