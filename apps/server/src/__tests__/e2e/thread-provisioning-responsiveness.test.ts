import { describe, it } from "vitest";
import { runThreadProvisioningResponsivenessScenario } from "./thread-provisioning-responsiveness.scenario.js";
import { e2eTimeoutMs } from "./provider-mode.js";

describe.skip(// TODO: rewrite after event-type-unification + protocol-boundary-contracts cleanup
"e2e: thread detail stays responsive while provisioning", () => {
  it(
    "serves thread and timeline requests while worktree provisioning is still in flight",
    runThreadProvisioningResponsivenessScenario,
    e2eTimeoutMs(15_000, 120_000),
  );
});
