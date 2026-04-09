import path from "node:path";
import type { HostDaemonCommandResult } from "@bb/host-daemon-contract";
import { CommandDispatchError } from "../command-dispatch-support.js";
import type { CommandOf } from "../command-dispatch-support.js";
import { isFsErrorWithCode } from "../fs-errors.js";
import { finalizeListedFiles, listFilesRecursively } from "./file-list.js";
import { readFileForTransport } from "./file-read.js";
import { resolveNonSymlinkDirectoryPath } from "./root-path.js";

export async function listHostFiles(
  command: CommandOf<"host.list_files">,
): Promise<HostDaemonCommandResult<"host.list_files">> {
  if (!path.isAbsolute(command.path)) {
    throw new CommandDispatchError(
      "invalid_path",
      "Path must be absolute",
    );
  }

  try {
    const realRootPath = await resolveNonSymlinkDirectoryPath({
      description: "Path",
      path: command.path,
    });

    return finalizeListedFiles({
      filePaths: await listFilesRecursively(realRootPath, realRootPath),
      limit: command.limit,
      ...(command.query ? { query: command.query } : {}),
    });
  } catch (error) {
    if (isFsErrorWithCode(error, "ENOENT")) {
      return { files: [], truncated: false };
    }
    throw error;
  }
}

export async function readHostFile(
  command: CommandOf<"host.read_file">,
): Promise<HostDaemonCommandResult<"host.read_file">> {
  if (!path.isAbsolute(command.path)) {
    throw new CommandDispatchError(
      "invalid_path",
      "Path must be absolute",
    );
  }

  if (!path.isAbsolute(command.rootPath)) {
    throw new CommandDispatchError(
      "invalid_path",
      "rootPath must be absolute",
    );
  }

  return readFileForTransport({
    resolvedPath: command.path,
    resultPath: command.path,
    rootPath: command.rootPath,
  });
}
