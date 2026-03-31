import { describe, expect, it } from "vitest";
import { getTimelineBenchmarkScenarios } from "./helpers/timeline-benchmark.js";

describe("buildThreadTimeline", () => {
  const scenarios = getTimelineBenchmarkScenarios();

  for (const scenario of scenarios) {
    it(`matches the direct projection pipeline for ${scenario.id}`, () => {
      expect(scenario.buildSummary()).toEqual(scenario.buildExpectedSummary());
    });

    it(`keeps the summary payload smaller than the full grouped payload for ${scenario.id}`, () => {
      expect(scenario.summaryBytes).toBeLessThan(scenario.fullBytes);
    });
  }
});
