import { describe, it } from "vitest";
import { runEnvironmentDaemonRestartRoundtripScenario } from "./environment-daemon-restart-roundtrip.scenario.js";
import { supportsFakeCodexControl } from "./provider-mode.js";

const itWithSupportedProvider = supportsFakeCodexControl() ? it : it.skip;

describe.sequential("e2e: environment-daemon restart recovery", () => {
  itWithSupportedProvider(
    "completes the in-flight turn after the env-agent reconnects to the restarted server",
    runEnvironmentDaemonRestartRoundtripScenario,
    20_000,
  );
});
