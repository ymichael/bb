import { describe, expect, it } from "vitest";
import {
  resolveDefaultWorktreeBaseBranch,
  resolveManagedDefaultBaseBranchSpec,
} from "../../src/services/projects/worktree-base-branch.js";

describe("resolveDefaultWorktreeBaseBranch", () => {
  it("keeps the local branch when origin is missing", () => {
    expect(
      resolveDefaultWorktreeBaseBranch({
        defaultBranch: "main",
        defaultBranchRelation: null,
        originDefaultBranch: null,
      }),
    ).toBe("main");
  });

  it("uses origin when local default is equal, behind, or missing", () => {
    expect(
      resolveDefaultWorktreeBaseBranch({
        defaultBranch: "main",
        defaultBranchRelation: "equal",
        originDefaultBranch: "origin/main",
      }),
    ).toBe("origin/main");

    expect(
      resolveDefaultWorktreeBaseBranch({
        defaultBranch: "main",
        defaultBranchRelation: "local-behind",
        originDefaultBranch: "origin/main",
      }),
    ).toBe("origin/main");

    expect(
      resolveDefaultWorktreeBaseBranch({
        defaultBranch: null,
        defaultBranchRelation: null,
        originDefaultBranch: "origin/main",
      }),
    ).toBe("origin/main");
  });

  it("keeps local when local default is ahead, diverged, or unknown", () => {
    for (const relation of ["local-ahead", "diverged", "unknown"] as const) {
      expect(
        resolveDefaultWorktreeBaseBranch({
          defaultBranch: "main",
          defaultBranchRelation: relation,
          originDefaultBranch: "origin/main",
        }),
      ).toBe("main");
    }
  });
});

describe("resolveManagedDefaultBaseBranchSpec", () => {
  it("returns a named branch when the computed default differs from local", () => {
    expect(
      resolveManagedDefaultBaseBranchSpec({
        defaultBranch: "main",
        defaultBranchRelation: "local-behind",
        originDefaultBranch: "origin/main",
      }),
    ).toEqual({ kind: "named", name: "origin/main" });

    expect(
      resolveManagedDefaultBaseBranchSpec({
        defaultBranch: "main",
        defaultBranchRelation: "equal",
        originDefaultBranch: "origin/main",
      }),
    ).toEqual({ kind: "named", name: "origin/main" });
  });
});
