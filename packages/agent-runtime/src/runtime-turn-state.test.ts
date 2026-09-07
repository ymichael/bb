import { afterEach, describe, expect, it, vi } from "vitest";
import type { ThreadEvent } from "@bb/domain";
import { turnScope } from "@bb/domain";
import { RuntimeTurnState } from "./runtime-turn-state.js";

function turnStarted(
  turnId: string,
  options: { parentToolCallId?: string } = {},
): ThreadEvent {
  return {
    type: "turn/started",
    threadId: "t1",
    providerThreadId: "p1",
    ...(options.parentToolCallId
      ? { parentToolCallId: options.parentToolCallId }
      : {}),
    scope: turnScope(turnId),
  };
}

function turnCompleted(turnId: string): ThreadEvent {
  return {
    type: "turn/completed",
    threadId: "t1",
    providerThreadId: "p1",
    scope: turnScope(turnId),
    status: "completed",
  };
}

describe("RuntimeTurnState", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("tracks only the current active turn", () => {
    const state = new RuntimeTurnState();

    state.observe(turnStarted("turn-1"));
    expect(state.getActiveTurnId("t1")).toBe("turn-1");
    expect(state.getActiveThreadIds()).toEqual(["t1"]);

    state.observe(turnCompleted("turn-1"));
    expect(state.getActiveTurnId("t1")).toBeNull();
    expect(state.getActiveThreadIds()).toEqual([]);
  });

  it("keeps the root turn active when a delegated child completes", () => {
    const state = new RuntimeTurnState();

    state.observe(turnStarted("root-turn"));
    state.observe(turnStarted("child-turn", { parentToolCallId: "tool-1" }));
    state.observe(turnCompleted("child-turn"));

    expect(state.getActiveTurnId("t1")).toBe("root-turn");

    state.observe(turnCompleted("root-turn"));

    expect(state.getActiveTurnId("t1")).toBeNull();
  });

  it("ignores delegated child turn starts for active foreground state", async () => {
    vi.useFakeTimers();
    const state = new RuntimeTurnState();

    const waiter = state.waitForActiveTurn({
      threadId: "t1",
      timeoutMs: 100,
    });
    state.observe(turnStarted("child-turn", { parentToolCallId: "tool-1" }));
    vi.advanceTimersByTime(100);

    await expect(waiter).resolves.toBeNull();
    expect(state.getActiveTurnId("t1")).toBeNull();

    state.observe(turnStarted("root-turn"));
    state.observe(turnStarted("child-turn", { parentToolCallId: "tool-1" }));

    expect(state.getActiveTurnId("t1")).toBe("root-turn");
    expect(state.getActiveThreadIds()).toEqual(["t1"]);
  });

  it("resolves waitForActiveTurn immediately when a turn is active", async () => {
    const state = new RuntimeTurnState();
    state.observe(turnStarted("turn-1"));

    await expect(
      state.waitForActiveTurn({ threadId: "t1", timeoutMs: 5 }),
    ).resolves.toBe("turn-1");
  });

  it("resolves pending waiters when observe records turn/started", async () => {
    vi.useFakeTimers();
    const state = new RuntimeTurnState();

    const firstWaiter = state.waitForActiveTurn({
      threadId: "t1",
      timeoutMs: 5_000,
    });
    const secondWaiter = state.waitForActiveTurn({
      threadId: "t1",
      timeoutMs: 5_000,
    });
    state.observe(turnStarted("turn-1"));

    await expect(firstWaiter).resolves.toBe("turn-1");
    await expect(secondWaiter).resolves.toBe("turn-1");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("resolves waiters with null on timeout", async () => {
    vi.useFakeTimers();
    const state = new RuntimeTurnState();

    const waiter = state.waitForActiveTurn({ threadId: "t1", timeoutMs: 100 });
    vi.advanceTimersByTime(100);

    await expect(waiter).resolves.toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("resolves waiters with null when the thread is cleared", async () => {
    vi.useFakeTimers();
    const state = new RuntimeTurnState();

    const waiter = state.waitForActiveTurn({
      threadId: "t1",
      timeoutMs: 5_000,
    });
    state.clearThread("t1");

    await expect(waiter).resolves.toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("resolves all pending waiters with null on clear", async () => {
    vi.useFakeTimers();
    const state = new RuntimeTurnState();

    const firstWaiter = state.waitForActiveTurn({
      threadId: "t1",
      timeoutMs: 5_000,
    });
    const secondWaiter = state.waitForActiveTurn({
      threadId: "t2",
      timeoutMs: 5_000,
    });
    state.clear();

    await expect(firstWaiter).resolves.toBeNull();
    await expect(secondWaiter).resolves.toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps waiters for other threads pending when one thread starts a turn", async () => {
    vi.useFakeTimers();
    const state = new RuntimeTurnState();

    const otherWaiter = state.waitForActiveTurn({
      threadId: "t2",
      timeoutMs: 100,
    });
    state.observe(turnStarted("turn-1"));
    vi.advanceTimersByTime(100);

    await expect(otherWaiter).resolves.toBeNull();
  });
});
