import type { MachineLifecycle } from "@bb/domain";
import { describe, expect, it } from "vitest";
import { machinePhaseLabel } from "./MachinePhaseBadge";

function lifecycle(
  phase: MachineLifecycle["phase"],
  teardown: MachineLifecycle["teardown"] = null,
): MachineLifecycle {
  return { phase, suspendedAt: null, retireAt: null, progress: null, teardown };
}

describe("machinePhaseLabel", () => {
  it.each([
    ["active", null],
    ["destroyed", null],
    ["suspended", "Suspended"],
    ["retiring", "Retiring"],
  ] as const)("maps %s to %s", (phase, label) => {
    expect(machinePhaseLabel(lifecycle(phase))).toBe(label);
  });

  it("prioritizes cleanup failure over retiring", () => {
    expect(
      machinePhaseLabel(
        lifecycle("retiring", {
          status: "failed",
          attempt: 1,
          message: "uninstall failed",
        }),
      ),
    ).toBe("Cleanup failed");
  });
});
