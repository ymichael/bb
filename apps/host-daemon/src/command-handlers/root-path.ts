import fs from "node:fs/promises";
import { CommandDispatchError } from "../command-dispatch-support.js";

export interface ResolveNonSymlinkDirectoryPathArgs {
  description: string;
  path: string;
}

export async function resolveNonSymlinkDirectoryPath(
  args: ResolveNonSymlinkDirectoryPathArgs,
): Promise<string> {
  const rootStat = await fs.lstat(args.path);
  if (rootStat.isSymbolicLink()) {
    throw new CommandDispatchError(
      "invalid_path",
      `${args.description} "${args.path}" must not be a symlink`,
    );
  }
  if (!rootStat.isDirectory()) {
    throw new CommandDispatchError(
      "invalid_path",
      `${args.description} "${args.path}" is not a directory`,
    );
  }

  return fs.realpath(args.path);
}
