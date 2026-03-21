import { describe, it } from "vitest";
import { runEnvironmentDaemonRestartRoundtripScenario } from "./environment-daemon-restart-roundtrip.scenario.js";
import { supportsFakeCodexControl } from "./provider-mode.js";

const itWithSupportedProvider = supportsFakeCodexControl() ? it : it.skip;

describe.skip(// TODO: rewrite after event-type-unification + protocol-boundary-contracts cleanup
"e2e: environment-daemon restart recovery", () => {
  itWithSupportedProvider(
    "completes the in-flight turn after the env-daemon reconnects to the restarted server",
    runEnvironmentDaemonRestartRoundtripScenario,
    20_000,
  );
});
