import { describe, it } from "vitest";
import { runThreadSpawnRoundtripScenario } from "./thread-spawn-roundtrip.scenario.js";

describe.sequential("e2e: CLI -> HTTP -> daemon -> agent -> API", () => {
  it(
    "spawns a thread via CLI and records outbound + lifecycle events",
    runThreadSpawnRoundtripScenario,
    15_000,
  );
});
