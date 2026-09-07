import { describe, expect, it } from "vitest";
import {
  scheduleDeferredRealization,
  type FrameScheduler,
} from "./deferred-realization";

function fakeScheduler() {
  const frames = new Map<number, () => void>();
  const timers = new Map<ReturnType<typeof setTimeout>, () => void>();
  let nextFrame = 1;
  let nextTimer = 1;
  const scheduler: FrameScheduler = {
    requestAnimationFrame: (cb) => {
      const id = nextFrame++;
      frames.set(id, cb);
      return id;
    },
    cancelAnimationFrame: (id) => void frames.delete(id),
    setTimeout: (cb) => {
      const id = nextTimer++ as unknown as ReturnType<typeof setTimeout>;
      timers.set(id, cb);
      return id;
    },
    clearTimeout: (id) => void timers.delete(id),
  };
  const flushFrame = () => {
    const pending = [...frames.entries()];
    frames.clear();
    for (const [, cb] of pending) cb();
  };
  const fireTimers = () => {
    const pending = [...timers.values()];
    timers.clear();
    for (const cb of pending) cb();
  };
  return { scheduler, flushFrame, fireTimers, frames, timers };
}

describe("scheduleDeferredRealization", () => {
  it("realizes after two frames and clears the fallback timer", () => {
    const { scheduler, flushFrame, timers } = fakeScheduler();
    let calls = 0;
    scheduleDeferredRealization(() => calls++, scheduler);
    flushFrame();
    expect(calls).toBe(0);
    flushFrame();
    expect(calls).toBe(1);
    expect(timers.size).toBe(0);
  });

  it("falls back to the timeout when frames never fire, and then ignores frames", () => {
    const { scheduler, flushFrame, fireTimers, frames } = fakeScheduler();
    let calls = 0;
    scheduleDeferredRealization(() => calls++, scheduler);
    fireTimers();
    expect(calls).toBe(1);
    expect(frames.size).toBe(0);
    flushFrame();
    expect(calls).toBe(1);
  });

  it("never realizes after cancel", () => {
    const { scheduler, flushFrame, fireTimers } = fakeScheduler();
    let calls = 0;
    const cancel = scheduleDeferredRealization(() => calls++, scheduler);
    flushFrame();
    cancel();
    flushFrame();
    fireTimers();
    expect(calls).toBe(0);
  });

  it("realizes synchronously with zero frames", () => {
    const { scheduler, timers } = fakeScheduler();
    let calls = 0;
    scheduleDeferredRealization(() => calls++, scheduler, { frames: 0 });
    expect(calls).toBe(1);
    expect(timers.size).toBe(0);
  });
});
