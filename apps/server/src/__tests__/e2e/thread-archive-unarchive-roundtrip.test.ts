import { describe, it } from "vitest";
import { runThreadArchiveUnarchiveRoundtripScenario } from "./thread-archive-unarchive-roundtrip.scenario.js";
import { e2eTimeoutMs } from "./provider-mode.js";

describe.skip(// TODO: rewrite after event-type-unification + protocol-boundary-contracts cleanup
"e2e: archive and unarchive thread roundtrip", () => {
  it(
    "rejects tells while archived and accepts follow-ups again after unarchive",
    runThreadArchiveUnarchiveRoundtripScenario,
    e2eTimeoutMs(20_000, 150_000),
  );
});
