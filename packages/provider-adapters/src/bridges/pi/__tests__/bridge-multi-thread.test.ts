import { describe, expect, it } from "vitest";
import type { AgentSessionEvent } from "@mariozechner/pi-coding-agent";
import type {
  AssistantMessage,
  AssistantMessageEvent,
  Usage,
} from "@mariozechner/pi-ai";
import {
  translatePiEvent,
  createTurnCounterState,
} from "../event-translator.js";

function createUsage(overrides?: Partial<Usage>): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
    },
    ...overrides,
  };
}

function createAssistantMessage(text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    usage: createUsage(),
    stopReason: "stop",
    timestamp: 0,
  };
}

function createTextDeltaEvent(delta: string): AssistantMessageEvent {
  return {
    type: "text_delta",
    contentIndex: 0,
    delta,
    partial: createAssistantMessage(""),
  };
}

function createAgentStartEvent(): AgentSessionEvent {
  return { type: "agent_start" };
}

/**
 * Multi-thread isolation tests for the Pi bridge.
 *
 * The bridge now maintains a Map<threadId, PiThreadSession> instead of
 * module-level singletons. These tests verify that the event-translator
 * layer — with per-thread TurnCounterState — correctly isolates
 * concurrent thread lifecycles.
 */
describe("multi-thread bridge isolation", () => {
  it("concurrent threads get independent turn counters", () => {
    const counterA = createTurnCounterState();
    const counterB = createTurnCounterState();

    // Thread A: first turn
    const a1 = translatePiEvent(createAgentStartEvent(), "thread-A", undefined, counterA);
    expect(a1.turnId).toBe("turn-1");

    // Thread B: first turn (should also be turn-1, not turn-2)
    const b1 = translatePiEvent(createAgentStartEvent(), "thread-B", undefined, counterB);
    expect(b1.turnId).toBe("turn-1");

    // Thread A: complete turn, then start second turn
    const a1End = translatePiEvent(
      {
        type: "agent_end",
        messages: [createAssistantMessage("A done")],
      },
      "thread-A",
      a1.turnId,
      counterA,
    );
    expect(a1End.turnId).toBeUndefined();

    const a2 = translatePiEvent(createAgentStartEvent(), "thread-A", undefined, counterA);
    expect(a2.turnId).toBe("turn-2");

    // Thread B still on turn-1, unaffected by thread A's progress
    const b1Update = translatePiEvent(
      {
        type: "message_update",
        message: createAssistantMessage(""),
        assistantMessageEvent: createTextDeltaEvent("chunk"),
      },
      "thread-B",
      b1.turnId,
      counterB,
    );
    expect(b1Update.turnId).toBe("turn-1");
  });

  it("stopping one thread does not affect another thread's turn counter", () => {
    const counterA = createTurnCounterState();
    const counterB = createTurnCounterState();

    // Both threads start their first turn
    const a1 = translatePiEvent(createAgentStartEvent(), "thread-A", undefined, counterA);
    const b1 = translatePiEvent(createAgentStartEvent(), "thread-B", undefined, counterB);

    // Complete thread A
    translatePiEvent(
      {
        type: "agent_end",
        messages: [createAssistantMessage("A done")],
      },
      "thread-A",
      a1.turnId,
      counterA,
    );

    // Thread B starts turn 2 — should still be turn-2, not affected by A
    translatePiEvent(
      {
        type: "agent_end",
        messages: [createAssistantMessage("B done")],
      },
      "thread-B",
      b1.turnId,
      counterB,
    );
    const b2 = translatePiEvent(createAgentStartEvent(), "thread-B", undefined, counterB);
    expect(b2.turnId).toBe("turn-2");
  });

  it("events carry correct threadId for each session", () => {
    const counterA = createTurnCounterState();
    const counterB = createTurnCounterState();

    const resultA = translatePiEvent(createAgentStartEvent(), "thread-A", undefined, counterA);
    const resultB = translatePiEvent(createAgentStartEvent(), "thread-B", undefined, counterB);

    for (const n of resultA.notifications) {
      expect(n.params.threadId).toBe("thread-A");
    }

    for (const n of resultB.notifications) {
      expect(n.params.threadId).toBe("thread-B");
    }
  });
});
