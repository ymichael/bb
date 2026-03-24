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
    `Cannot proceed: ${label} has uncommitted changes`,
  );
}

/**
 * Promote: switch primary checkout to the environment's branch.
 * Both workspaces must be clean. Fails loudly if either has uncommitted changes.
 * Same-host: detach source HEAD, checkout branch on primary.
 * Cross-host: fetch from remote if branch not locally available, checkout on primary.
 */
export async function promoteWorkspace(
  source: Workspace,
  primary: Workspace,
  options?: { remote?: string },
): Promise<void> {
  await assertWorkspaceClean(source, "promote source");
  await assertWorkspaceClean(primary, "promote primary");

  const branch = await source.currentBranch;
  if (!branch) throw new Error("source has no branch (detached HEAD)");

  // Detach source HEAD to free the branch (same-host worktree constraint)
  await source.detachHead();

  // If remote specified, fetch first (cross-host)
  if (options?.remote) {
    await primary.fetch({ remote: options.remote, branch });
  }

  await primary.checkoutBranch(branch);
}

/**
 * Demote: switch primary checkout back to default branch, reattach source.
 * Primary must be clean. Fails loudly if dirty.
 */
export async function demoteWorkspace(
  source: Workspace,
  primary: Workspace,
  defaultBranch: string,
  envBranch: string,
): Promise<void> {
  await assertWorkspaceClean(primary, "demote primary");

  await primary.checkoutBranch(defaultBranch);

  // Reattach source to its branch
  await source.checkoutBranch(envBranch);
}
