import { describe, expect, it, vi } from "vitest";
import { scheduleDeferredPluginFrontendBoot } from "./plugin-frontend-boot-schedule";

function makeHarness() {
  let resolvePainted: () => void = () => {};
  const painted = new Promise<void>((resolve) => {
    resolvePainted = resolve;
  });
  const idleCallbacks: Array<() => void> = [];
  const cancelIdle = vi.fn();
  const timers = new Map<number, () => void>();
  let nextTimer = 1;
  const boot = vi.fn();
  const cancel = scheduleDeferredPluginFrontendBoot(boot, {
    whenRoutePainted: () => painted,
    requestIdle: (callback) => {
      idleCallbacks.push(callback);
      return cancelIdle;
    },
    setTimeout: (callback, _ms) => {
      const id = nextTimer++;
      timers.set(id, callback);
      return id;
    },
    clearTimeout: (id) => {
      timers.delete(id);
    },
    timeoutMs: 1_500,
  });
  return {
    boot,
    cancel,
    cancelIdle,
    idleCallbacks,
    timers,
    paint: () => {
      resolvePainted();
      return Promise.resolve();
    },
    fireTimeout: () => {
      for (const callback of [...timers.values()]) callback();
    },
  };
}

describe("scheduleDeferredPluginFrontendBoot", () => {
  it("waits for route paint and then idle before booting, and drops the timeout", async () => {
    const h = makeHarness();
    expect(h.boot).not.toHaveBeenCalled();
    expect(h.idleCallbacks).toHaveLength(0);

    await h.paint();
    expect(h.boot).not.toHaveBeenCalled();
    expect(h.idleCallbacks).toHaveLength(1);

    h.idleCallbacks[0]!();
    expect(h.boot).toHaveBeenCalledTimes(1);
    expect(h.timers.size).toBe(0);
    h.fireTimeout();
    expect(h.boot).toHaveBeenCalledTimes(1);
  });

  it("boots at the timeout when the route never paints, and ignores a later paint", async () => {
    const h = makeHarness();
    h.fireTimeout();
    expect(h.boot).toHaveBeenCalledTimes(1);

    await h.paint();
    expect(h.idleCallbacks).toHaveLength(0);
    expect(h.boot).toHaveBeenCalledTimes(1);
  });

  it("boots at the timeout when idle never comes after paint, and cancels the idle request", async () => {
    const h = makeHarness();
    await h.paint();
    expect(h.idleCallbacks).toHaveLength(1);
    h.fireTimeout();
    expect(h.boot).toHaveBeenCalledTimes(1);
    expect(h.cancelIdle).toHaveBeenCalledTimes(1);
    h.idleCallbacks[0]!();
    expect(h.boot).toHaveBeenCalledTimes(1);
  });

  it("cancel prevents boot from every path", async () => {
    const h = makeHarness();
    h.cancel();
    expect(h.timers.size).toBe(0);
    await h.paint();
    expect(h.idleCallbacks).toHaveLength(0);
    h.fireTimeout();
    expect(h.boot).not.toHaveBeenCalled();
  });
});
