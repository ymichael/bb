import { describe, it } from "vitest";
import { runEnvironmentAgentRestartRoundtripScenario } from "./environment-agent-restart-roundtrip.scenario.js";

describe.sequential("e2e: environment-agent restart recovery", () => {
  it(
    "recovers buffered provider events automatically after daemon restart",
    runEnvironmentAgentRestartRoundtripScenario,
    20_000,
  );
});
