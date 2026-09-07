import { describe, expect, it } from "vitest";
import { reconcileReasoningLevel } from "../src/reasoning-level.js";

describe("reconcileReasoningLevel", () => {
  it("reconciles ultracode down to xhigh on a model without ultracode", () => {
    expect(
      reconcileReasoningLevel("ultracode", [
        "low",
        "medium",
        "high",
        "xhigh",
        "max",
      ]),
    ).toBe("xhigh");
  });

  it("keeps ultracode when the new model supports it", () => {
    expect(
      reconcileReasoningLevel("ultracode", ["xhigh", "ultracode", "max"]),
    ).toBe("ultracode");
  });

  it("reconciles ultra down toward max when ultra is unavailable", () => {
    expect(
      reconcileReasoningLevel("ultra", [
        "low",
        "medium",
        "high",
        "xhigh",
        "max",
      ]),
    ).toBe("max");
  });

  it("keeps the previous level when the new model supports it", () => {
    expect(
      reconcileReasoningLevel("high", [
        "low",
        "medium",
        "high",
        "xhigh",
        "max",
      ]),
    ).toBe("high");
  });

  it("picks the closest lower level when the previous was the absolute max", () => {
    expect(
      reconcileReasoningLevel("max", ["low", "medium", "high", "xhigh"]),
    ).toBe("xhigh");
  });

  it("breaks ties by preferring the higher level", () => {
    expect(reconcileReasoningLevel("medium", ["low", "high"])).toBe("high");
  });

  it("picks the closest level upward when nothing is below the previous", () => {
    expect(reconcileReasoningLevel("low", ["high", "max"])).toBe("high");
  });

  it("picks the closest level downward when nothing is above the previous", () => {
    expect(reconcileReasoningLevel("max", ["low", "medium"])).toBe("medium");
  });

  it("handles a single supported level", () => {
    expect(reconcileReasoningLevel("max", ["low"])).toBe("low");
  });

  it("reconciles a stored low preference to none for a non-reasoning model", () => {
    expect(reconcileReasoningLevel("low", ["none"])).toBe("none");
  });

  it("throws when supported is empty", () => {
    expect(() => reconcileReasoningLevel("medium", [])).toThrow();
  });
});
