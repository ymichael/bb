import type { HostDaemonCommandResult } from "@bb/host-daemon-contract";
import type { RuntimeManager } from "../runtime-manager.js";
import { requireWorkspaceEnvironment, type CommandOf } from "../command-dispatch-support.js";

export async function squashMerge(
  command: CommandOf<"workspace.squash_merge">,
  runtimeManager: RuntimeManager,
): Promise<HostDaemonCommandResult<"workspace.squash_merge">> {
  const entry = await requireWorkspaceEnvironment(command, runtimeManager);
  const result = await entry.workspace.squashMergeInto({
    targetBranch: command.targetBranch,
  });
  return {
    merged: result.merged,
    commitSha: result.commitSha,
  };
}

export async function promoteWorkspace(
  command: CommandOf<"workspace.promote">,
  runtimeManager: RuntimeManager,
): Promise<HostDaemonCommandResult<"workspace.promote">> {
  const entry = await requireWorkspaceEnvironment(command, runtimeManager);
  const primaryWorkspace = await runtimeManager.openWorkspace(command.primaryPath);
  await entry.workspace.promote(primaryWorkspace);
  return { ok: true };
}

export async function demoteWorkspace(
  command: CommandOf<"workspace.demote">,
  runtimeManager: RuntimeManager,
): Promise<HostDaemonCommandResult<"workspace.demote">> {
  const entry = await requireWorkspaceEnvironment(command, runtimeManager);
  const primaryWorkspace = await runtimeManager.openWorkspace(command.primaryPath);
  await entry.workspace.demote({ primary: primaryWorkspace, defaultBranch: command.defaultBranch, envBranch: command.envBranch });
  return { ok: true };
}
