import path from "node:path";
import type { HostDaemonCommandResult } from "@bb/host-daemon-contract";
import { CommandDispatchError } from "../command-dispatch-support.js";
import type { CommandOf } from "../command-dispatch-support.js";
import { isFsErrorWithCode } from "../fs-errors.js";
import { finalizeListedFiles, listFilesRecursively } from "./file-list.js";
import { readFileForTransport, readFileFromGitRef } from "./file-read.js";
import { resolveNonSymlinkDirectoryPath } from "./root-path.js";

/**
 * Conservative subset of git's ref name grammar. We only need to refuse
 * shell-meaningful punctuation and ref-traversal sequences before passing
 * the value as a `git` argument. `execFile` already prevents shell expansion,
 * but rejecting bad refs early gives a clean error and avoids ambiguity in
 * the `<ref>:<path>` join.
 */
const SAFE_GIT_REF_REGEX = /^[A-Za-z0-9_./~^@-]+$/;

function assertSafeGitRef(ref: string): void {
  if (
    ref.length === 0 ||
    ref.startsWith("-") ||
    ref.includes("..") ||
    !SAFE_GIT_REF_REGEX.test(ref)
  ) {
    throw new CommandDispatchError("invalid_ref", `Invalid git ref: ${ref}`);
  }
}

export async function listHostFiles(
  command: CommandOf<"host.list_files">,
): Promise<HostDaemonCommandResult<"host.list_files">> {
  if (!path.isAbsolute(command.path)) {
    throw new CommandDispatchError("invalid_path", "Path must be absolute");
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
    throw new CommandDispatchError("invalid_path", "Path must be absolute");
  }

  const rootPath = command.rootPath;
  if (rootPath !== undefined && !path.isAbsolute(rootPath)) {
    throw new CommandDispatchError("invalid_path", "rootPath must be absolute");
  }

  if (command.ref !== undefined) {
    if (rootPath === undefined) {
      throw new CommandDispatchError(
        "invalid_path",
        "rootPath is required when ref is set",
      );
    }
    assertSafeGitRef(command.ref);
    return readFileFromGitRef({
      rootPath,
      resolvedPath: command.path,
      resultPath: command.path,
      ref: command.ref,
    });
  }

  return readFileForTransport({
    resolvedPath: command.path,
    resultPath: command.path,
    ...(rootPath !== undefined ? { rootPath } : {}),
  });
}
