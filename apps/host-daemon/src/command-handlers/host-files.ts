import path from "node:path";
import type { HostDaemonCommandResult } from "@bb/host-daemon-contract";
import { CommandDispatchError } from "../command-dispatch-support.js";
import type { CommandOf } from "../command-dispatch-support.js";
import { isFsErrorWithCode } from "../fs-errors.js";
import {
  finalizeListedFiles,
  finalizeListedPaths,
  listFilesRecursively,
  listPathsRecursively,
} from "./file-list.js";
import {
  readFileForTransport,
  readFileFromGitRef,
  readFileMetadataForTransport,
  readRootRelativeFileForTransport,
} from "./file-read.js";
import { resolveNonSymlinkDirectoryPath } from "./root-path.js";

/**
 * Conservative subset of git's ref name grammar. We only need to refuse
 * shell-meaningful punctuation and ref-traversal sequences before passing
 * the value as a `git` argument. `execFile` already prevents shell expansion,
 * but rejecting bad refs early gives a clean error and avoids ambiguity in
 * the `<ref>:<path>` join.
 */
const SAFE_GIT_REF_REGEX = /^[A-Za-z0-9_./~^@-]+$/;

interface HostDiskPathCommand {
  path: string;
  rootPath?: string;
}

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

function assertAbsoluteHostDiskPathCommand(command: HostDiskPathCommand): void {
  if (!path.isAbsolute(command.path)) {
    throw new CommandDispatchError("invalid_path", "Path must be absolute");
  }

  const rootPath = command.rootPath;
  if (rootPath !== undefined && !path.isAbsolute(rootPath)) {
    throw new CommandDispatchError("invalid_path", "rootPath must be absolute");
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

export async function listHostPaths(
  command: CommandOf<"host.list_paths">,
): Promise<HostDaemonCommandResult<"host.list_paths">> {
  if (!path.isAbsolute(command.path)) {
    throw new CommandDispatchError("invalid_path", "Path must be absolute");
  }

  try {
    const realRootPath = await resolveNonSymlinkDirectoryPath({
      description: "Path",
      path: command.path,
    });

    return finalizeListedPaths({
      paths: await listPathsRecursively({
        dir: realRootPath,
        root: realRootPath,
        includeFiles: command.includeFiles,
        includeDirectories: command.includeDirectories,
      }),
      limit: command.limit,
      includeFiles: command.includeFiles,
      includeDirectories: command.includeDirectories,
      ...(command.query ? { query: command.query } : {}),
    });
  } catch (error) {
    if (isFsErrorWithCode(error, "ENOENT")) {
      return { paths: [], truncated: false };
    }
    throw error;
  }
}

export async function readHostFile(
  command: CommandOf<"host.read_file">,
): Promise<HostDaemonCommandResult<"host.read_file">> {
  assertAbsoluteHostDiskPathCommand(command);

  if (command.ref !== undefined) {
    if (command.rootPath === undefined) {
      throw new CommandDispatchError(
        "invalid_path",
        "rootPath is required when ref is set",
      );
    }
    assertSafeGitRef(command.ref);
    return readFileFromGitRef({
      rootPath: command.rootPath,
      resolvedPath: command.path,
      resultPath: command.path,
      ref: command.ref,
    });
  }

  return readFileForTransport({
    resolvedPath: command.path,
    resultPath: command.path,
    ...(command.rootPath !== undefined ? { rootPath: command.rootPath } : {}),
  });
}

export async function readHostFileMetadata(
  command: CommandOf<"host.file_metadata">,
): Promise<HostDaemonCommandResult<"host.file_metadata">> {
  assertAbsoluteHostDiskPathCommand(command);
  return readFileMetadataForTransport({
    resolvedPath: command.path,
    resultPath: command.path,
    ...(command.rootPath !== undefined ? { rootPath: command.rootPath } : {}),
  });
}

export async function readHostRelativeFile(
  command: CommandOf<"host.read_file_relative">,
): Promise<HostDaemonCommandResult<"host.read_file_relative">> {
  return readRootRelativeFileForTransport({
    rootPath: command.rootPath,
    relativePath: command.path,
    dotfiles: command.dotfiles,
  });
}
