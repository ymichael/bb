import { describe, it } from "vitest";
import { runThreadArchiveUnarchiveRoundtripScenario } from "./thread-archive-unarchive-roundtrip.scenario.js";

describe.sequential("e2e: archive and unarchive thread roundtrip", () => {
  it(
    "rejects tells while archived and accepts follow-ups again after unarchive",
    runThreadArchiveUnarchiveRoundtripScenario,
    20_000,
  );
});
