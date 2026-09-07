import type { GitSourceInspection } from "@bb/domain";
import type { BaseBranchSpec } from "@bb/server-contract";

interface ResolveDefaultWorktreeBaseBranchArgs {
  defaultBranch: GitSourceInspection["defaultBranch"];
  defaultBranchRelation: GitSourceInspection["defaultBranchRelation"];
  originDefaultBranch: GitSourceInspection["originDefaultBranch"];
}

export function resolveDefaultWorktreeBaseBranch(
  args: ResolveDefaultWorktreeBaseBranchArgs,
): string | null {
  if (!args.originDefaultBranch) {
    return args.defaultBranch;
  }
  if (!args.defaultBranch) {
    return args.originDefaultBranch;
  }
  if (
    args.defaultBranchRelation === "equal" ||
    args.defaultBranchRelation === "local-behind"
  ) {
    return args.originDefaultBranch;
  }
  return args.defaultBranch;
}

export function resolveManagedDefaultBaseBranchSpec(
  args: ResolveDefaultWorktreeBaseBranchArgs,
): BaseBranchSpec {
  const defaultWorktreeBaseBranch = resolveDefaultWorktreeBaseBranch(args);
  if (
    defaultWorktreeBaseBranch &&
    defaultWorktreeBaseBranch !== args.defaultBranch
  ) {
    return { kind: "named", name: defaultWorktreeBaseBranch };
  }

  return { kind: "default" };
}
