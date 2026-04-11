import { describe, expect, it } from "vitest";
import {
  buildManagedBranchName,
  buildManagedTargetPath,
} from "../../src/services/threads/thread-create-helpers.js";

describe("buildManagedBranchName", () => {
  it("uses the full thread ID", () => {
    expect(buildManagedBranchName("thr_abc123def456")).toBe(
      "bb/thr_abc123def456",
    );
  });

  it("produces unique names for threads with shared prefixes", () => {
    const a = buildManagedBranchName("thr_abc123def456");
    const b = buildManagedBranchName("thr_abc123xyz789");
    expect(a).not.toBe(b);
  });
});

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
