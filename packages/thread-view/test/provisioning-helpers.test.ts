import { describe, expect, it } from "vitest";
import { mergeProvisioningMetadata } from "../src/provisioning-helpers.js";

describe("mergeProvisioningMetadata", () => {
  it("coalesces repeated provisioning phases into one sequence", () => {
    const merged = mergeProvisioningMetadata(
      {
        provisioningId: "provision_1",
        transcript: [
          {
            type: "step",
            key: "workspace-started",
            text: "Preparing workspace",
            status: "started",
          },
        ],
      },
      {
        environmentId: "env_1",
        provisioningId: "provision_1",
        transcript: [
          {
            type: "step",
            key: "workspace-started",
            text: "Preparing workspace",
            status: "completed",
          },
          {
            type: "step",
            key: "provider-create",
            text: "Preparing worktree…",
            status: "started",
          },
        ],
      },
    );

    expect(merged?.transcript).toEqual([
      {
        type: "step",
        key: "workspace-started",
        text: "Preparing workspace",
        status: "completed",
      },
      {
        type: "step",
        key: "provider-create",
        text: "Preparing worktree…",
        status: "started",
      },
    ]);
  });
});
