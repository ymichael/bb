import fs from "node:fs/promises";
import path from "node:path";
import type { HostDaemonCommandResult, environmentProvisionCommandSchema } from "@bb/host-daemon-contract";
import { type CommandDispatchOptions, type CommandOf } from "../command-dispatch-support.js";

export async function provisionEnvironment(
  command: CommandOf<"environment.provision">,
  options: CommandDispatchOptions,
): Promise<HostDaemonCommandResult<"environment.provision">> {
  const alreadyExists = options.runtimeManager.get(command.environmentId) != null;
  const entry = await options.runtimeManager.ensureEnvironment({
    environmentId: command.environmentId,
    provision: toProvisionWorkspaceOptions(command),
  });
  const ranSetup =
    !alreadyExists && entry.workspace.managed
      ? await detectSetupScript(command)
      : false;
  const defaultBranch = entry.workspace.isGitRepo
    ? (await entry.workspace.getStatus()).branch.defaultBranch || null
    : null;
  return {
    path: entry.workspace.path,
    isGitRepo: entry.workspace.isGitRepo,
    isWorktree: entry.workspace.isWorktree,
    branchName: await entry.workspace.currentBranch(),
    defaultBranch,
    ranSetup,
  };
}

export async function detectSetupScript(
  command: typeof environmentProvisionCommandSchema._type,
): Promise<boolean> {
  let scriptParentPath: string;
  let scriptName: string;
  switch (command.workspaceProvisionType) {
    case "unmanaged":
      // Unmanaged workspaces don't run setup scripts (managed check in caller prevents this)
      return false;
    case "managed-worktree":
    case "managed-clone":
      scriptParentPath = command.sourcePath;
      scriptName = command.setupScript;
      break;
  }
  try {
    await fs.access(path.join(scriptParentPath, scriptName));
    return true;
  } catch {
    return false;
  }
}

export function toProvisionWorkspaceOptions(
  command: typeof environmentProvisionCommandSchema._type,
) {
  switch (command.workspaceProvisionType) {
    case "unmanaged": {
      return {
        workspaceProvisionType: "unmanaged" as const,
        path: command.path,
      };
    }
    case "managed-worktree":
    case "managed-clone": {
      return {
        workspaceProvisionType: command.workspaceProvisionType,
        sourcePath: command.sourcePath,
        targetPath: command.targetPath,
        branchName: command.branchName,
        scriptName: command.setupScript,
        timeoutMs: command.setupTimeoutMs,
      };
    }
  }
}
