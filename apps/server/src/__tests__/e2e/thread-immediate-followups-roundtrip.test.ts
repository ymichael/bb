import { describe, it } from "vitest";
import { runThreadImmediateFollowupsRoundtripScenario } from "./thread-immediate-followups-roundtrip.scenario.js";
import { e2eTimeoutMs } from "./provider-mode.js";

describe.skip(// TODO: rewrite after event-type-unification + protocol-boundary-contracts cleanup
"e2e: immediate follow-ups roundtrip", () => {
  it(
    "accepts an immediate follow-up after idle for local and worktree threads",
    runThreadImmediateFollowupsRoundtripScenario,
    e2eTimeoutMs(30_000, 180_000),
  );
});
