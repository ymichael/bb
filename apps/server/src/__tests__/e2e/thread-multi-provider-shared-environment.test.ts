import { describe, it } from "vitest";
import { runThreadMultiProviderSharedEnvironmentScenario } from "./thread-multi-provider-shared-environment.scenario.js";

const shouldRun =
  process.env.BB_E2E_PROVIDER_MODE === "real" &&
  Boolean(process.env.BB_E2E_MULTI_PROVIDER_A?.trim()) &&
  Boolean(process.env.BB_E2E_MULTI_PROVIDER_B?.trim());

describe.runIf(shouldRun).sequential("e2e: multi-provider shared environment", () => {
  it(
    "keeps providers isolated while sharing one environment-daemon",
    runThreadMultiProviderSharedEnvironmentScenario,
    240_000,
  );
});
