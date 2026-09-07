import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import { describe, expect, it, vi } from "vitest";
import { createConcurrencyLimitHostEntry } from "./host.js";

describe("Concurrency limit host entry", () => {
  it("reports the host's available parallelism", async () => {
    const availableParallelism = vi.fn(() => 12);
    const harness = experimental_createHostEntryHarness(
      createConcurrencyLimitHostEntry({ availableParallelism }),
    );

    await expect(
      harness.experimental_call("getCapacity", null),
    ).resolves.toEqual({ availableParallelism: 12 });
    expect(availableParallelism).toHaveBeenCalledOnce();
    await harness.experimental_dispose();
  });
});
