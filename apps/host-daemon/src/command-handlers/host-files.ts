import fs from "node:fs/promises";
import path from "node:path";
import type { HostDaemonCommandResult } from "@bb/host-daemon-contract";
import { CommandDispatchError } from "../command-dispatch-support.js";
import type { CommandOf } from "../command-dispatch-support.js";
import { isFsErrorWithCode } from "../fs-errors.js";
import { finalizeListedFiles, listFilesRecursively } from "./file-list.js";
import { readFileForTransport } from "./file-read.js";

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
    const stat = await fs.stat(command.path);
    if (!stat.isDirectory()) {
      throw new CommandDispatchError(
        "invalid_path",
        "Path is not a directory",
      );
    }

    return finalizeListedFiles({
      filePaths: await listFilesRecursively(command.path, command.path),
      limit: command.limit,
      ...(command.query ? { query: command.query } : {}),
    });
  } catch (error) {
    if (isFsErrorWithCode(error, "ENOENT")) {
      throw new CommandDispatchError(
        "ENOENT",
        `Path does not exist: ${command.path}`,
      );
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

  return readFileForTransport(command.path, command.path);
}
