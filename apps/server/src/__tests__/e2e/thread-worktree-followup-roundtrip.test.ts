import { describe, it } from "vitest";
import { runThreadWorktreeFollowupRoundtripScenario } from "./thread-worktree-followup-roundtrip.scenario.js";
import { e2eTimeoutMs } from "./provider-mode.js";

describe.sequential("e2e: worktree follow-up roundtrip", () => {
  it(
    "accepts a follow-up after an idle worktree thread restores its managed environment-daemon",
    runThreadWorktreeFollowupRoundtripScenario,
    e2eTimeoutMs(30_000, 120_000),
  );
});
