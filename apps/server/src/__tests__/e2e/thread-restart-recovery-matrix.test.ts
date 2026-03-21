import { describe, it } from "vitest";
import { runThreadRestartRecoveryMatrixScenario } from "./thread-restart-recovery-matrix.scenario.js";
import { supportsFakeCodexControl } from "./provider-mode.js";

const itWithSupportedProvider = supportsFakeCodexControl() ? it : it.skip;

describe.skip(// TODO: rewrite after event-type-unification + protocol-boundary-contracts cleanup
"e2e: restart recovery matrix", () => {
  itWithSupportedProvider(
    "covers missing-worker restart recovery and idle restart follow-up stability for local and worktree threads",
    runThreadRestartRecoveryMatrixScenario,
    90_000,
  );
});
