import { describe, expect, it } from "vitest";
import type { ThreadEvent } from "@bb/domain";
import { RuntimeTurnReplayFilter } from "./runtime-turn-replay-filter.js";
import { RuntimeTurnState } from "./runtime-turn-state.js";

function turnStarted(turnId: string): ThreadEvent {
  return {
    type: "turn/started",
    threadId: "t1",
    providerThreadId: "p1",
    turnId,
  };
}

function turnCompleted(turnId: string): ThreadEvent {
  return {
    type: "turn/completed",
    threadId: "t1",
    providerThreadId: "p1",
    turnId,
    status: "completed",
  };
}

describe("RuntimeTurnState", () => {
  it("tracks only the current active turn", () => {
    const state = new RuntimeTurnState();

    state.observe(turnStarted("turn-1"));
    expect(state.getActiveTurnId("t1")).toBe("turn-1");

    state.observe(turnCompleted("turn-1"));
    expect(state.getActiveTurnId("t1")).toBeUndefined();
  });
});

describe("RuntimeTurnReplayFilter", () => {
  it("marks replayed turn starts as drops", () => {
    const filter = new RuntimeTurnReplayFilter();

    expect(filter.observe(turnStarted("turn-1")).kind).toBe("emit");
    expect(filter.observe(turnCompleted("turn-1")).kind).toBe("emit");

    expect(filter.observe(turnStarted("turn-1"))).toEqual({
      kind: "drop-replayed-turn-start",
      threadId: "t1",
      turnId: "turn-1",
    });
  });
});
