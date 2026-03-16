import { describe, it } from "vitest";
import { runMultiThreadStressScenario } from "./thread-multi-thread-stress.scenario.js";
import { e2eTimeoutMs } from "./provider-mode.js";

describe.sequential("e2e: multi-thread stress", () => {
  it(
    "spawns 4 concurrent threads across local and worktree environments, sends parallel follow-ups, and validates shared sessions and attachments",
    runMultiThreadStressScenario,
    e2eTimeoutMs(60_000, 300_000),
  );
});
