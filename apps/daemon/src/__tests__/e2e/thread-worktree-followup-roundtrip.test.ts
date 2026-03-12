import { describe, it } from "vitest";
import { runThreadWorktreeFollowupRoundtripScenario } from "./thread-worktree-followup-roundtrip.scenario.js";

describe.sequential("e2e: worktree follow-up roundtrip", () => {
  it(
    "accepts a follow-up after an idle worktree thread restores its managed environment-agent",
    runThreadWorktreeFollowupRoundtripScenario,
    30_000,
  );
});
