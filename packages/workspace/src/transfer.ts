import { runGit, WorkspaceError } from "./git.js";
import { Workspace } from "./workspace.js";

export interface WorkspaceExport {
  type: "branch";
  branch: string;
  remote?: string;
}

export interface ImportResult {
  previousBranch?: string;
  stashRef: string | null;
}

export async function exportWorkspace(
  workspace: Workspace,
  options?: { pushToRemote?: string },
): Promise<WorkspaceExport> {
  const branch = await workspace.currentBranch;
  if (!branch) {
    throw new WorkspaceError("Cannot export a detached workspace");
  }

  if (options?.pushToRemote) {
    await runGit(["push", options.pushToRemote, branch], { cwd: workspace.path });
    return {
      type: "branch",
      branch,
      remote: options.pushToRemote,
    };
  }

  await workspace.detachHead();
  return {
    type: "branch",
    branch,
  };
}

export async function importWorkspace(
  primary: Workspace,
  exportData: WorkspaceExport,
): Promise<ImportResult> {
  if (exportData.remote) {
    await primary.fetch({
      remote: exportData.remote,
      branch: exportData.branch,
    });
  }

  const stashRef = await primary.stash("bb-promote");
  const previousBranch = await primary.currentBranch;
  await primary.checkoutBranch(exportData.branch);

  return {
    previousBranch,
    stashRef,
  };
}
