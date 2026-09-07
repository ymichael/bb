import { describe, expect, it } from "vitest";
import { computeDiffWorkerPoolSize } from "./diff-worker-pool";

describe("computeDiffWorkerPoolSize", () => {
  it("caps a touch device at two workers however many cores it reports", () => {
    expect(
      computeDiffWorkerPoolSize({
        hardwareConcurrency: 8,
        coarsePointer: true,
        deviceMemory: undefined,
      }),
    ).toBe(2);
  });

  it("caps a low-memory device at two workers", () => {
    expect(
      computeDiffWorkerPoolSize({
        hardwareConcurrency: 8,
        coarsePointer: false,
        deviceMemory: 4,
      }),
    ).toBe(2);
    expect(
      computeDiffWorkerPoolSize({
        hardwareConcurrency: 8,
        coarsePointer: false,
        deviceMemory: 8,
      }),
    ).toBe(4);
  });

  it("caps a desktop at four workers and leaves one core free below that", () => {
    expect(
      computeDiffWorkerPoolSize({
        hardwareConcurrency: 16,
        coarsePointer: false,
        deviceMemory: undefined,
      }),
    ).toBe(4);
    expect(
      computeDiffWorkerPoolSize({
        hardwareConcurrency: 4,
        coarsePointer: false,
        deviceMemory: undefined,
      }),
    ).toBe(3);
  });

  it("uses one worker on dual-core or unknown hardware", () => {
    expect(
      computeDiffWorkerPoolSize({
        hardwareConcurrency: 2,
        coarsePointer: false,
        deviceMemory: undefined,
      }),
    ).toBe(1);
    expect(
      computeDiffWorkerPoolSize({
        hardwareConcurrency: undefined,
        coarsePointer: true,
        deviceMemory: undefined,
      }),
    ).toBe(1);
  });
});
