import { describe, expect, it } from "vitest";
import { assessEnvironmentAgentSessionCompatibility } from "../environment-agent-session-compatibility.js";

describe("environment-agent session compatibility", () => {
  it("marks sessions missing required commands for replacement", () => {
    const assessment = assessEnvironmentAgentSessionCompatibility({
      id: "sess-1",
      environmentId: "env-1",
      agentId: "agent-1",
      agentInstanceId: "instance-1",
      protocolVersion: 1,
      selectedCapabilities: {
        commands: ["thread.start"],
        features: ["worker_metadata"],
      },
      status: "active",
      leaseExpiresAt: 1_000,
      createdAt: 1,
      updatedAt: 1,
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
    const assessment = assessEnvironmentAgentSessionCompatibility({
      id: "sess-1",
      environmentId: "env-1",
      agentId: "agent-1",
      agentInstanceId: "instance-1",
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
      status: "active",
      leaseExpiresAt: 1_000,
      createdAt: 1,
      updatedAt: 1,
    });

    expect(assessment.compatibility.disposition).toBe("degrade");
    expect(assessment.compatibility.missingRequiredCommands).toEqual([]);
    expect(assessment.compatibility.missingOptionalCommands).toContain("thread.rename");
    expect(assessment.compatibility.missingOptionalCommands).toContain("provider.list_catalog");
  });
});
