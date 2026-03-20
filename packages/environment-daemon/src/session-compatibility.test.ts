import { describe, expect, it } from "vitest";
import { assessEnvironmentDaemonSessionCompatibility } from "./session-compatibility.js";

describe("environment-daemon session compatibility", () => {
  it("marks sessions missing required commands for replacement", () => {
    const assessment = assessEnvironmentDaemonSessionCompatibility({
      protocolVersion: 1,
      selectedCapabilities: {
        commands: ["thread.start"],
        features: ["worker_metadata"],
      },
    });

    expect(assessment.compatibility).toMatchObject({
      disposition: "replace",
      missingRequiredCommands: [
        "provider.ensure",
        "thread.resume",
        "turn.run",
      ],
    });
  });

  it("marks sessions missing only optional commands/features as degraded", () => {
    const assessment = assessEnvironmentDaemonSessionCompatibility({
      protocolVersion: 1,
      selectedCapabilities: {
        commands: [
          "provider.ensure",
          "thread.start",
          "thread.resume",
          "turn.run",
        ],
        features: ["worker_metadata", "provider_metadata"],
      },
    });

    expect(assessment.compatibility.disposition).toBe("degrade");
    expect(assessment.compatibility.missingRequiredCommands).toEqual([]);
    expect(assessment.compatibility.missingOptionalCommands).toContain("thread.rename");
    expect(assessment.compatibility.missingOptionalCommands).toContain("provider.list_catalog");
  });
});
