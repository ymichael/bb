import {
  readDefaultBranchRefs,
  type DefaultBranchRelation,
  type GitProcessOptions,
} from "bb-environment-provider-host/git";

export type BaseBranchSpec =
  | { kind: "named"; name: string }
  | { kind: "default" };

interface ResolveDefaultWorktreeBaseBranchArgs {
  defaultBranch: string | null;
  defaultBranchRelation: DefaultBranchRelation | null;
  originDefaultBranch: string | null;
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

export async function resolveWorktreeBaseBranch(
  sourcePath: string,
  requested: BaseBranchSpec,
  options: GitProcessOptions = {},
): Promise<string | null> {
  if (requested.kind === "named") {
    return requested.name;
  }
  const refs = await readDefaultBranchRefs(sourcePath, options);
  const resolved = resolveManagedDefaultBaseBranchSpec({
    defaultBranch: refs.defaultBranch ?? null,
    defaultBranchRelation: refs.defaultBranchRelation ?? null,
    originDefaultBranch: refs.originDefaultBranch ?? null,
  });
  return resolved.kind === "named" ? resolved.name : null;
}
