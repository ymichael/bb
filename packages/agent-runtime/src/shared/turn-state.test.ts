import { describe, expect, it } from "vitest";
import type { ThreadEvent, ThreadEventTokenUsageBreakdown } from "@bb/domain";
import {
  createProviderTurnStateRegistry,
  type ProviderTurnState,
} from "./turn-state.js";

interface TestTurnState extends ProviderTurnState {}

function createTokenUsage(): ThreadEventTokenUsageBreakdown {
  return {
    cachedInputTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0,
  };
}

function createTurnState(): TestTurnState {
  return {
    assistantMessageCounter: 0,
    counter: 0,
    currentTurnId: undefined,
    cumulativeTokens: createTokenUsage(),
    openAssistantMessageIdsByScope: new Map(),
    openReasoningItemIdsByScope: new Map(),
    toolItemsByCallId: new Map(),
  };
}

describe("turn-state", () => {
  it("looks up existing state without creating missing thread state", () => {
    let createCount = 0;
    const registry = createProviderTurnStateRegistry({
      createState: () => {
        createCount += 1;
        return createTurnState();
      },
    });
    const state = registry.getOrCreate({ threadId: "thread-1" });

    expect(registry.get({ threadId: "thread-1" })).toBe(state);
    expect(registry.get({ threadId: "thread-missing" })).toBeNull();
    expect(createCount).toBe(1);

    registry.getOrCreate({ threadId: "thread-missing" });
    expect(createCount).toBe(2);
  });

  it("reuses scoped assistant ids until the scope is completed", () => {
    const registry = createProviderTurnStateRegistry({
      createState: createTurnState,
    });
    const state = registry.getOrCreate({ threadId: "thread-1" });

    const firstId = registry.getOrCreateAssistantMessageId({
      assistantIdPrefix: "assistant",
      state,
    });
    const secondId = registry.getOrCreateAssistantMessageId({
      assistantIdPrefix: "assistant",
      state,
    });
    const completedId = registry.resolveCompletedAssistantMessageId({
      assistantIdPrefix: "assistant",
      state,
    });
    const nextId = registry.getOrCreateAssistantMessageId({
      assistantIdPrefix: "assistant",
      state,
    });

    expect(secondId).toBe(firstId);
    expect(completedId).toBe(firstId);
    expect(nextId).not.toBe(firstId);
  });

  it("starts turns, clears transient state on finish, and increments turn ids", () => {
    const registry = createProviderTurnStateRegistry({
      createState: createTurnState,
    });
    const state = registry.getOrCreate({ threadId: "thread-1" });
    const events: ThreadEvent[] = [];

    const firstTurnId = registry.ensureTurnStarted({
      events,
      state,
      threadId: "thread-1",
    });
    state.openAssistantMessageIdsByScope.set("root", "assistant-1");
    state.openReasoningItemIdsByScope.set("root:0", "reasoning-1");
    state.toolItemsByCallId.set("tool-1", {
      type: "commandExecution",
      id: "tool-1",
      command: "pwd",
      cwd: "/tmp",
      status: "pending",
      approvalStatus: null,
    });

    registry.finishTurn({
      state,
      threadId: "thread-1",
    });

    const secondTurnId = registry.ensureTurnStarted({
      events,
      state,
      threadId: "thread-1",
    });

    expect(firstTurnId).toBe("turn-1");
    expect(secondTurnId).toBe("turn-2");
    expect(state.openAssistantMessageIdsByScope.size).toBe(0);
    expect(state.openReasoningItemIdsByScope.size).toBe(0);
    expect(state.toolItemsByCallId.size).toBe(0);
    expect(events.map((event) => event.type)).toEqual([
      "turn/started",
      "turn/started",
    ]);
  });

  it("uses the configured turn id prefix for current and completed turns", () => {
    const registry = createProviderTurnStateRegistry({
      createState: createTurnState,
      turnIdPrefix: "turn_runtime_",
    });
    const state = registry.getOrCreate({ threadId: "thread-1" });
    const events: ThreadEvent[] = [];

    expect(registry.getCurrentOrLastTurnId({ state })).toBe("");

    const firstTurnId = registry.ensureTurnStarted({
      events,
      state,
      threadId: "thread-1",
    });
    expect(firstTurnId).toBe("turn_runtime_1");
    expect(registry.getCurrentOrLastTurnId({ state })).toBe("turn_runtime_1");

    registry.finishTurn({
      state,
      threadId: "thread-1",
    });
    expect(registry.getCurrentOrLastTurnId({ state })).toBe("turn_runtime_1");

    const secondTurnId = registry.ensureTurnStarted({
      events,
      state,
      threadId: "thread-1",
    });
    expect(secondTurnId).toBe("turn_runtime_2");
  });

  it("evicts only inactive thread state when the registry exceeds capacity", () => {
    const registry = createProviderTurnStateRegistry({
      createState: createTurnState,
      maxEntries: 2,
    });
    const threadOneState = registry.getOrCreate({ threadId: "thread-1" });
    const threadOneEvents: ThreadEvent[] = [];
    registry.ensureTurnStarted({
      events: threadOneEvents,
      state: threadOneState,
      threadId: "thread-1",
    });

    const threadTwoState = registry.getOrCreate({ threadId: "thread-2" });
    const threadThreeState = registry.getOrCreate({ threadId: "thread-3" });

    expect(registry.getOrCreate({ threadId: "thread-1" })).toBe(threadOneState);
    expect(registry.getOrCreate({ threadId: "thread-3" })).toBe(
      threadThreeState,
    );

    const threadTwoRecreatedState = registry.getOrCreate({
      threadId: "thread-2",
    });
    expect(threadTwoRecreatedState).not.toBe(threadTwoState);
    expect(registry.getOrCreate({ threadId: "thread-1" })).toBe(threadOneState);
  });
});
