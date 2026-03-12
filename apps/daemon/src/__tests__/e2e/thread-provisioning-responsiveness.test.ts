import { describe, it } from "vitest";
import { runThreadProvisioningResponsivenessScenario } from "./thread-provisioning-responsiveness.scenario.js";

describe.sequential("e2e: thread detail stays responsive while provisioning", () => {
  it(
    "serves thread and timeline requests while worktree provisioning is still in flight",
    runThreadProvisioningResponsivenessScenario,
    15_000,
  );
});
