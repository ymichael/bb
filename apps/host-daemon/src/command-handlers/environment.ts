import fs from "node:fs/promises";
import path from "node:path";
import type { HostDaemonCommandResult, environmentProvisionCommandSchema } from "@bb/host-daemon-contract";
import { CommandDispatchError, type CommandDispatchOptions, type CommandOf } from "../command-dispatch-support.js";

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
  return {
    path: entry.workspace.path,
    isGitRepo: entry.workspace.isGitRepo,
    isWorktree: entry.workspace.isWorktree,
    branchName: await entry.workspace.currentBranch(),
    ranSetup,
  };
}

export async function detectSetupScript(
  command: typeof environmentProvisionCommandSchema._type,
): Promise<boolean> {
  const scriptName = command.scriptName ?? ".bb-env-setup.sh";
  const scriptParentPath =
    command.workspaceProvisionType === "unmanaged"
      ? command.path
      : command.sourcePath;
  if (!scriptParentPath) {
    return false;
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
      const sourcePath = command.sourcePath ?? command.path;
      if (!sourcePath) {
        throw new CommandDispatchError(
          "invalid_command",
          `Unmanaged provision missing source path for environment ${command.environmentId}`,
        );
      }
      return {
        workspaceProvisionType: "unmanaged" as const,
        path: sourcePath,
      };
    }
    case "managed-worktree":
    case "managed-clone": {
      if (!command.sourcePath || !command.targetPath || !command.branchName) {
        throw new CommandDispatchError(
          "invalid_command",
          `Managed provision missing sourcePath/targetPath/branchName for environment ${command.environmentId}`,
        );
      }
      return {
        workspaceProvisionType: command.workspaceProvisionType,
        sourcePath: command.sourcePath,
        targetPath: command.targetPath,
        branchName: command.branchName,
        scriptName: command.scriptName,
        timeoutMs: command.timeoutMs,
      };
    }
  }
}
