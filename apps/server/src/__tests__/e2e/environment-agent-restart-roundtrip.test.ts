import { describe, it } from "vitest";
import { runEnvironmentAgentRestartRoundtripScenario } from "./environment-agent-restart-roundtrip.scenario.js";
import { supportsFakeCodexControl } from "./provider-mode.js";

const itWithSupportedProvider = supportsFakeCodexControl() ? it : it.skip;

describe.sequential("e2e: environment-agent restart recovery", () => {
  itWithSupportedProvider(
    "completes the in-flight turn after the env-agent reconnects to the restarted daemon",
    runEnvironmentAgentRestartRoundtripScenario,
    20_000,
  );
});
