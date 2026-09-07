import { describe, expect, it } from "vitest";
import {
  carryBranchSelectionAcrossScope,
  getBranchSelectionScopeKey,
} from "./root-compose-branch-selection";

describe("getBranchSelectionScopeKey", () => {
  it("returns null until both project and environment are present", () => {
    expect(
      getBranchSelectionScopeKey({
        environmentValue: "host:host_1:worktree",
        projectId: undefined,
      }),
    ).toBeNull();
    expect(
      getBranchSelectionScopeKey({ environmentValue: "", projectId: "proj_1" }),
    ).toBeNull();
  });

  it("distinguishes worktree and local modes within the same project", () => {
    const worktree = getBranchSelectionScopeKey({
      environmentValue: "host:host_1:worktree",
      projectId: "proj_1",
    });
    const local = getBranchSelectionScopeKey({
      environmentValue: "host:host_1:local",
      projectId: "proj_1",
    });
    expect(worktree).not.toBeNull();
    expect(worktree).not.toBe(local);
  });
});

describe("carryBranchSelectionAcrossScope", () => {
  it("keeps the pick while the scope is unchanged", () => {
    const selectedBranch = { name: "origin/feature", isNew: false };
    expect(
      carryBranchSelectionAcrossScope({
        previousScopeKey: "proj_1\u0000host:host_1:worktree",
        currentScopeKey: "proj_1\u0000host:host_1:worktree",
        selectedBranch,
      }),
    ).toBe(selectedBranch);
  });

  it("re-seeds the fresh default when toggling New Worktree -> Working Locally -> New Worktree", () => {
    const worktreeKey = "proj_1\u0000host:host_1:worktree";
    const localKey = "proj_1\u0000host:host_1:local";
    const picked = { name: "origin/feature", isNew: true };

    const afterLeavingWorktree = carryBranchSelectionAcrossScope({
      previousScopeKey: worktreeKey,
      currentScopeKey: localKey,
      selectedBranch: picked,
    });
    expect(afterLeavingWorktree).toBeNull();

    expect(
      carryBranchSelectionAcrossScope({
        previousScopeKey: localKey,
        currentScopeKey: worktreeKey,
        selectedBranch: afterLeavingWorktree,
      }),
    ).toBeNull();
  });
});
