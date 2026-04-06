import type { HostDaemonCommandResult } from "@bb/host-daemon-contract";
import type { RuntimeManager } from "../runtime-manager.js";
import {
  requireWorkspaceEnvironment,
} from "../command-dispatch-support.js";
import type { CommandOf } from "../command-dispatch-support.js";
import { finalizeListedFiles } from "./file-list.js";

export async function listWorkspaceFiles(
  command: CommandOf<"workspace.list_files">,
  runtimeManager: RuntimeManager,
): Promise<HostDaemonCommandResult<"workspace.list_files">> {
  const entry = await requireWorkspaceEnvironment(command, runtimeManager);
  const filePaths = await entry.workspace.listFiles();

  return finalizeListedFiles({
    filePaths,
    limit: command.limit,
    ...(command.query ? { query: command.query } : {}),
  });
}

export async function listBranches(
  command: CommandOf<"workspace.list_branches">,
  runtimeManager: RuntimeManager,
): Promise<HostDaemonCommandResult<"workspace.list_branches">> {
  const entry = await requireWorkspaceEnvironment(command, runtimeManager);
  const [branches, current] = await Promise.all([
    entry.workspace.listBranches(),
    entry.workspace.getCurrentBranch(),
  ]);
  return { branches, current };
}
