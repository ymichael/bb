import path from "node:path";
import {
  detectGitRepo,
  getCurrentBranch,
  listBranches,
  readDefaultBranch,
} from "@bb/host-workspace";
import type { HostDaemonCommandResult } from "@bb/host-daemon-contract";
import { CommandDispatchError } from "../command-dispatch-support.js";
import type { CommandOf } from "../command-dispatch-support.js";

export async function listHostBranches(
  command: CommandOf<"host.list_branches">,
): Promise<HostDaemonCommandResult<"host.list_branches">> {
  if (!path.isAbsolute(command.path)) {
    throw new CommandDispatchError("invalid_path", "Path must be absolute");
  }

  if (!(await detectGitRepo(command.path))) {
    return { branches: [], current: null, defaultBranch: null };
  }

  const [branches, current, defaultBranch] = await Promise.all([
    listBranches(command.path),
    getCurrentBranch(command.path),
    readDefaultBranch(command.path),
  ]);
  // Pin the source's default branch to the top of the list so the picker
  // surfaces it first; everything else preserves git's alphabetical order.
  const sorted =
    defaultBranch && branches.includes(defaultBranch)
      ? [defaultBranch, ...branches.filter((b) => b !== defaultBranch)]
      : branches;
  return {
    branches: sorted,
    current: current ?? null,
    defaultBranch: defaultBranch ?? null,
  };
}
