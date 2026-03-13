import { describe, it } from "vitest";
import { runCodexDynamicToolsDaemonRoundtripScenario } from "./codex-dynamic-tools-daemon-roundtrip.scenario.js";

const shouldRun = process.env.BEANBAG_E2E_PROVIDER_MODE === "real";

describe.runIf(shouldRun).sequential("e2e: daemon dynamic tools with real Codex", () => {
  it(
    "round-trips a Codex tool call through environment-agent and Beanbag",
    runCodexDynamicToolsDaemonRoundtripScenario,
    180_000,
  );
});
