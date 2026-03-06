import { describe, expect, it } from "vitest";
import type { IEnvironment } from "@beanbag/environment";
import { WorkflowService } from "../index.js";

function makeEnvironment(args?: {
  isolatedWorkspace?: boolean;
  supportsPromote?: boolean;
  supportsDemote?: boolean;
  supportsSquashMerge?: boolean;
}): IEnvironment {
  return {
    kind: "test",
    info: {
      id: "test",
      displayName: "Test Environment",
      description: "",
      capabilities: {
        host_filesystem: true,
        isolated_workspace: args?.isolatedWorkspace ?? false,
        promote_primary_checkout: args?.supportsPromote ?? false,
        demote_primary_checkout: args?.supportsDemote ?? false,
        squash_merge: args?.supportsSquashMerge ?? false,
      },
    },
    serialize() {
      return {};
    },
    dispose() {},
    exists() {
      return true;
    },
    supportsHostFilesystemAccess() {
      return true;
    },
    isIsolatedWorkspace() {
      return args?.isolatedWorkspace ?? false;
    },
    getCheckoutSnapshot() {
      return {
        branch: "test",
        head: "abc123",
        detached: false,
      };
    },
    getWorkspaceRootUnsafe() {
      return "/tmp/test";
    },
    getWorkspaceStatus() {
      return {
        state: "clean",
        changedFiles: 0,
        insertions: 0,
        deletions: 0,
        workspaceChangedFiles: 0,
        workspaceInsertions: 0,
        workspaceDeletions: 0,
        hasUncommittedChanges: false,
        hasCommittedUnmergedChanges: false,
        aheadCount: 0,
        behindCount: 0,
      };
    },
    watchWorkspaceStatus() {
      return () => {};
    },
    async commitWorkspace() {
      return {
        ok: true,
        commitCreated: false,
        message: "noop",
        workStatus: this.getWorkspaceStatus(),
      };
    },
    listWorkspaceCommitsSinceRef() {
      return [];
    },
    getWorkspaceDiff() {
      return { diff: "", truncated: false };
    },
    spawn() {
      throw new Error("not implemented");
    },
    shouldRunSetupScript() {
      return false;
    },
    supportsPromoteToActiveWorkspace() {
      return args?.supportsPromote ?? false;
    },
    supportsDemoteFromActiveWorkspace() {
      return args?.supportsDemote ?? false;
    },
    supportsSquashMergeIntoDefaultBranch() {
      return args?.supportsSquashMerge ?? false;
    },
    promoteToActiveWorkspace() {
      throw new Error("not implemented");
    },
    demoteFromActiveWorkspace() {
      throw new Error("not implemented");
    },
    async squashMergeIntoDefaultBranch() {
      throw new Error("not implemented");
    },
    run() {
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  };
}

describe("WorkflowService", () => {
  const service = new WorkflowService();

  it("lists the built-in workflow definitions", () => {
    expect(service.listDefinitions()).toEqual([
      {
        kind: "noop",
        displayName: "No Structured Workflow",
        description: "No pre-defined branch, commit, or merge policy.",
        requiredEnvironmentCapabilities: [],
      },
      {
        kind: "branch-commit-merge",
        displayName: "Branch, Commit, Merge",
        description: "Work in an isolated branch workspace and complete with commit and merge-back.",
        requiredEnvironmentCapabilities: [
          "isolated_workspace",
          "promote_primary_checkout",
          "demote_primary_checkout",
          "squash_merge",
        ],
      },
    ]);
  });

  it("requires isolated workspace capabilities for branch-commit-merge", () => {
    const compatibility = service
      .getDefinition("branch-commit-merge")
      .checkCompatibility(makeEnvironment());

    expect(compatibility.ok).toBe(false);
    expect(compatibility.missingRequirements.map((item) => item.capability)).toEqual([
      "isolated_workspace",
      "promote_primary_checkout",
      "demote_primary_checkout",
      "squash_merge",
    ]);
  });

  it("allows primary-checkout operations only for branch-commit-merge", () => {
    const noopDecision = service.evaluateOperationPolicy("noop", "promote", {
      status: "idle",
      archived: false,
      primaryCheckoutActive: false,
    });
    const branchDecision = service.evaluateOperationPolicy("branch-commit-merge", "promote", {
      status: "idle",
      archived: false,
      primaryCheckoutActive: false,
    });

    expect(noopDecision).toEqual({
      allowed: false,
      reason: "This workflow does not support primary checkout promotion",
      requiresDemoteFirst: false,
    });
    expect(branchDecision).toEqual({
      allowed: true,
      requiresDemoteFirst: false,
    });
  });

  it("requires demotion before commit and squash only for branch-commit-merge", () => {
    expect(
      service.evaluateOperationPolicy("noop", "commit", {
        status: "idle",
        archived: false,
        primaryCheckoutActive: true,
      }),
    ).toEqual({
      allowed: true,
      shouldQueue: false,
      requiresDemoteFirst: false,
    });

    expect(
      service.evaluateOperationPolicy("branch-commit-merge", "squash_merge", {
        status: "active",
        archived: false,
        primaryCheckoutActive: true,
      }),
    ).toEqual({
      allowed: true,
      shouldQueue: true,
      requiresDemoteFirst: true,
    });
  });

  it("archives only branch-commit-merge squash success by default", () => {
    expect(
      service.shouldAutoArchiveOnSuccess({
        workflowId: "noop",
        operation: "commit",
      }),
    ).toBe(false);
    expect(
      service.shouldAutoArchiveOnSuccess({
        workflowId: "noop",
        operation: "commit",
        requested: true,
      }),
    ).toBe(true);
    expect(
      service.shouldAutoArchiveOnSuccess({
        workflowId: "branch-commit-merge",
        operation: "commit",
      }),
    ).toBe(false);
    expect(
      service.shouldAutoArchiveOnSuccess({
        workflowId: "branch-commit-merge",
        operation: "squash_merge",
      }),
    ).toBe(true);
    expect(
      service.shouldAutoArchiveOnSuccess({
        workflowId: "branch-commit-merge",
        operation: "squash_merge",
        requested: false,
      }),
    ).toBe(false);
  });
});
