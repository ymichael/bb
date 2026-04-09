import { describe, expect, it } from "vitest";
import { createAsyncLane } from "../../src/services/lib/async-lane.js";

describe("async lane", () => {
  it("serializes work per key and cleans up settled tails", async () => {
    const lane = createAsyncLane<string>();
    const order: string[] = [];
    let signalFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      signalFirstStarted = resolve;
    });
    let releaseFirst!: () => void;
    const allowFirstToFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = lane.run("host-1", async () => {
      order.push("first-start");
      signalFirstStarted();
      await allowFirstToFinish;
      order.push("first-end");
    });
    const second = lane.run("host-1", async () => {
      order.push("second-start");
      order.push("second-end");
    });

    expect(lane.size()).toBe(1);
    await firstStarted;
    expect(order).toEqual(["first-start"]);

    releaseFirst();
    await Promise.all([first, second]);

    expect(order).toEqual([
      "first-start",
      "first-end",
      "second-start",
      "second-end",
    ]);
    expect(lane.size()).toBe(0);
  });

  it("removes a key after a failing task so later work can start cleanly", async () => {
    const lane = createAsyncLane<string>();

    await expect(
      lane.run("host-2", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(lane.size()).toBe(0);

    await lane.run("host-2", async () => undefined);
    expect(lane.size()).toBe(0);
  });
});
