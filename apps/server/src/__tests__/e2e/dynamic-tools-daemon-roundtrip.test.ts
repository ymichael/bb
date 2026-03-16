import { describe, it } from "vitest";
import { runDynamicToolsDaemonRoundtripScenario } from "./dynamic-tools-daemon-roundtrip.scenario.js";

const shouldRun = process.env.BB_E2E_PROVIDER_MODE === "real";

describe.runIf(shouldRun).sequential("e2e: daemon dynamic tools roundtrip", () => {
  it(
    "round-trips a dynamic tool call through environment-daemon and BB",
    runDynamicToolsDaemonRoundtripScenario,
    180_000,
  );
});
