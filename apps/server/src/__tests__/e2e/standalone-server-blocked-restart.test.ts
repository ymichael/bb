import { describe, it } from "vitest";
import { runStandaloneServerBlockedRestartScenario } from "./standalone-server-blocked-restart.scenario.js";
import { supportsFakeCodexControl } from "./provider-mode.js";

const itWithSupportedProvider = supportsFakeCodexControl() ? it : it.skip;

describe.skip(// TODO: rewrite after event-type-unification + protocol-boundary-contracts cleanup
"e2e: standalone server blocked restart", () => {
  itWithSupportedProvider(
    "rejects non-forced restart requests while active local and worktree threads exist",
    runStandaloneServerBlockedRestartScenario,
    60_000,
  );
});
