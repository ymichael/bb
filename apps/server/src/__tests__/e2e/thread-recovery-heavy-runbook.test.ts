import { describe, it } from "vitest";
import {
  runArchiveAfterWorkerLossRecoveryScenario,
  runQueuedFollowUpWorkerLossScenario,
  runStaleOldSessionNoiseScenario,
} from "./thread-recovery-heavy-runbook.scenario.js";
import { supportsFakeCodexControl } from "./provider-mode.js";

const itWithSupportedProvider = supportsFakeCodexControl() ? it : it.skip;

describe.skip(// TODO: rewrite after event-type-unification + protocol-boundary-contracts cleanup
"e2e: recovery-heavy runbook scenarios", () => {
  itWithSupportedProvider(
    "recovers queued follow-ups after worker loss in local mode",
    async () => runQueuedFollowUpWorkerLossScenario("local"),
    90_000,
  );

  itWithSupportedProvider(
    "recovers queued follow-ups after worker loss in worktree mode",
    async () => runQueuedFollowUpWorkerLossScenario("worktree"),
    90_000,
  );

  itWithSupportedProvider(
    "supports archive and unarchive after worker-loss recovery",
    runArchiveAfterWorkerLossRecoveryScenario,
    90_000,
  );

  itWithSupportedProvider(
    "rejects stale old-session noise after replacement",
    runStaleOldSessionNoiseScenario,
    90_000,
  );
});
