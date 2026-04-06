import { describe, expect, it } from "vitest";
import { buildManagedTargetPath } from "../../src/services/threads/thread-create-helpers.js";

describe("buildManagedTargetPath", () => {
  it("keeps managed workspaces next to local sources", () => {
    expect(
      buildManagedTargetPath(
        "/tmp/project-root",
        "proj_123",
        "thr_456",
      ),
    ).toBe("/tmp/.bb-worktrees/proj_123/thr_456");
  });

  it("uses a local sandbox workspace root for remote git sources", () => {
    expect(
      buildManagedTargetPath(
        "https://github.com/octocat/Hello-World.git",
        "proj_123",
        "thr_456",
      ),
    ).toBe("/tmp/bb-managed-workspaces/proj_123/thr_456");
  });
});
