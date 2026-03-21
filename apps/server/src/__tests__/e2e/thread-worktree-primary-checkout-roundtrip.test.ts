import { describe, it } from "vitest";
import { runThreadWorktreePrimaryCheckoutRoundtripScenario } from "./thread-worktree-primary-checkout-roundtrip.scenario.js";
import { e2eTimeoutMs } from "./provider-mode.js";

describe.skip(// TODO: rewrite after event-type-unification + protocol-boundary-contracts cleanup
"e2e: worktree primary checkout promotion", () => {
  it(
    "promotes and demotes a worktree thread through the CLI while keeping project primary-checkout state coherent",
    runThreadWorktreePrimaryCheckoutRoundtripScenario,
    e2eTimeoutMs(30_000, 120_000),
  );
});
