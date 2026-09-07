import { describe, expect, it } from "vitest";
import { resolveTrailingRefetchDelayMs } from "./realtime-cache-registry";

describe("resolveTrailingRefetchDelayMs", () => {
  it("keeps fast threads responsive", () => {
    expect(resolveTrailingRefetchDelayMs(0)).toBe(50);
    expect(resolveTrailingRefetchDelayMs(12)).toBe(50);
  });

  it("waits out an expensive build so the duty cycle stays near half", () => {
    expect(resolveTrailingRefetchDelayMs(240)).toBe(240);
  });

  it("caps the delay so a pathological build cannot freeze updates", () => {
    expect(resolveTrailingRefetchDelayMs(30_000)).toBe(1_000);
  });
});
