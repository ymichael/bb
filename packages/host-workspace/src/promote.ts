import { hasUncommittedChanges, WorkspaceError } from "./git.js";
import { Workspace } from "./workspace.js";

async function assertWorkspaceClean(
  workspace: Workspace,
  label: string,
): Promise<void> {
  if (!(await hasUncommittedChanges(workspace.path))) {
    return;
  }

  throw new WorkspaceError(
    "workspace_dirty",
    `Cannot proceed: ${label} has uncommitted changes`,
  );
}

/**
 * Promote: switch primary checkout to the environment's branch.
 * Both workspaces must be clean. Fails loudly if either has uncommitted changes.
 * Detach source HEAD, checkout branch on primary (same-host worktree constraint).
 */
export async function promoteWorkspace(
  source: Workspace,
  primary: Workspace,
): Promise<void> {
  await assertWorkspaceClean(source, "promote source");
  await assertWorkspaceClean(primary, "promote primary");

  const branch = await source.currentBranch;
  if (!branch) throw new WorkspaceError("detached_head", "source has no branch (detached HEAD)");

  // Detach source HEAD to free the branch (same-host worktree constraint)
  await source.detachHead();

  await primary.checkoutBranch(branch);
}

/**
 * Demote: switch primary checkout back to default branch, reattach source.
 * Primary must be clean. Fails loudly if dirty.
 */
export async function demoteWorkspace(args: {
  source: Workspace;
  primary: Workspace;
  defaultBranch: string;
  envBranch: string;
}): Promise<void> {
  await assertWorkspaceClean(args.primary, "demote primary");

  await args.primary.checkoutBranch(args.defaultBranch);

  // Reattach source to its branch
  await args.source.checkoutBranch(args.envBranch);
}
