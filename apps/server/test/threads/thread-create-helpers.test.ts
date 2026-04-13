import { describe, expect, it } from "vitest";
import {
  buildManagedBranchName,
  buildManagedTargetPath,
} from "../../src/services/threads/thread-create-helpers.js";
import { sanitizeGeneratedBranchSlug } from "../../src/services/threads/title-generation.js";

describe("sanitizeGeneratedBranchSlug", () => {
  it("normalizes spaces, punctuation, and repeated separators", () => {
    expect(sanitizeGeneratedBranchSlug("  Fix: login -- flow!!  ")).toBe(
      "fix-login-flow",
    );
  });

  it("rejects empty slugs", () => {
    expect(sanitizeGeneratedBranchSlug("!!!")).toBeNull();
  });

  it("caps slugs before branch construction", () => {
    expect(sanitizeGeneratedBranchSlug("a".repeat(80))).toHaveLength(48);
  });
});

describe("buildManagedBranchName", () => {
  it("falls back to the full thread ID", () => {
    expect(buildManagedBranchName({ threadId: "thr_abc123def456" })).toBe(
      "bb/thr_abc123def456",
    );
  });

  it("includes a sanitized slug before the full thread ID", () => {
    expect(
      buildManagedBranchName({
        branchSlug: "Fix login flow!",
        threadId: "thr_abc123def456",
      }),
    ).toBe("bb/fix-login-flow-thr_abc123def456");
  });

  it("falls back to the full thread ID when the slug is empty after sanitizing", () => {
    expect(
      buildManagedBranchName({
        branchSlug: "!!!",
        threadId: "thr_abc123def456",
      }),
    ).toBe("bb/thr_abc123def456");
  });

  it("produces unique names for threads with the same slug", () => {
    const a = buildManagedBranchName({
      branchSlug: "same task",
      threadId: "thr_abc123def456",
    });
    const b = buildManagedBranchName({
      branchSlug: "same task",
      threadId: "thr_abc123xyz789",
    });
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
