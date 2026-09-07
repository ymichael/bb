import { expect, it } from "vitest";
import { runFirstPartyRecordedConformance } from "@bb/provider-bridge-protocol/testing";

it("reproduces every recorded matrix cell", async () => {
  const run = await runFirstPartyRecordedConformance({
    servesProvider: (providerId) => providerId === "pi",
    label: "pi",
  });
  expect(run.cells).toEqual([
    "fork",
    "resume",
    "steer",
    "stop-interrupt",
    "turn-tools",
    "user-question",
  ]);
  console.info(run.report);
  expect(run.failures).toEqual([]);
}, 240_000);
