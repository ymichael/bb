import { describe, it } from "vitest";
import { runStandaloneDaemonCliRoundtripScenario } from "./standalone-daemon-cli-roundtrip.scenario.js";

describe.sequential("e2e: standalone daemon cli roundtrip", () => {
  it(
    "covers spawn, restart, follow-up, steer, and post-stop follow-up via the standalone daemon process",
    runStandaloneDaemonCliRoundtripScenario,
    60_000,
  );
});
