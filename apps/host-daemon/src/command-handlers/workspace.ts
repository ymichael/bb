import type { HostDaemonCommandResult } from "@bb/host-daemon-contract";
import type { RuntimeManager } from "../runtime-manager.js";
import {
  requireWorkspaceEnvironment,
  type CommandOf,
} from "../command-dispatch-support.js";

export async function squashMerge(
  command: CommandOf<"workspace.squash_merge">,
  runtimeManager: RuntimeManager,
): Promise<HostDaemonCommandResult<"workspace.squash_merge">> {
  const entry = await requireWorkspaceEnvironment(command, runtimeManager);
  const result = await entry.workspace.squashMerge({
    targetBranch: command.targetBranch,
    commitMessage: command.commitMessage,
  });
  return {
    merged: result.merged,
    commitSha: result.commitSha,
    commitSubject: result.commitSubject,
  };
}
