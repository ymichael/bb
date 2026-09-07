import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  DirectoryEntry,
  HostDaemonOnlineRpcResult,
  HostPathEntryKind,
} from "@bb/host-daemon-contract";
import {
  CommandDispatchError,
  type CommandDispatchOptions,
  type CommandOf,
} from "../command-dispatch-support.js";
import { isFsErrorWithCode } from "../fs-errors.js";
import { userExecutableProcessOptions } from "../user-executable-env.js";
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
): Promise<HostDaemonOnlineRpcResult<"host.list_files">> {
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
): Promise<HostDaemonOnlineRpcResult<"host.list_paths">> {
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

const DIRECTORY_BROWSE_SKIP_NAMES = new Set(["node_modules"]);

function compareDirectoryEntries(a: DirectoryEntry, b: DirectoryEntry): number {
  if (a.kind !== b.kind) {
    return a.kind === "directory" ? -1 : 1;
  }
  return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
}

export async function browseHostDirectory(
  command: CommandOf<"host.browse_directory">,
): Promise<HostDaemonOnlineRpcResult<"host.browse_directory">> {
  const requestedPath = command.path ?? os.homedir();
  if (!path.isAbsolute(requestedPath)) {
    throw new CommandDispatchError("invalid_path", "Path must be absolute");
  }

  const stat = await fs.stat(requestedPath);
  if (!stat.isDirectory()) {
    throw new CommandDispatchError(
      "invalid_path",
      `Path "${requestedPath}" is not a directory`,
    );
  }
  const directory = await fs.realpath(requestedPath);

  const dirents = await fs.readdir(directory, { withFileTypes: true });
  const entries: DirectoryEntry[] = [];
  for (const dirent of dirents) {
    if (dirent.name.startsWith(".")) continue;
    if (DIRECTORY_BROWSE_SKIP_NAMES.has(dirent.name)) continue;

    const fullPath = path.join(directory, dirent.name);
    let kind: HostPathEntryKind;
    if (dirent.isSymbolicLink()) {
      try {
        kind = (await fs.stat(fullPath)).isDirectory() ? "directory" : "file";
      } catch {
        continue;
      }
    } else if (dirent.isDirectory()) {
      kind = "directory";
    } else if (dirent.isFile()) {
      kind = "file";
    } else {
      continue;
    }

    entries.push({ kind, name: dirent.name, path: fullPath });
  }

  entries.sort(compareDirectoryEntries);

  const parent = path.dirname(directory);
  return {
    directory,
    parent: parent === directory ? null : parent,
    entries,
  };
}

export async function checkHostPathsExist(
  command: CommandOf<"host.paths_exist">,
): Promise<HostDaemonOnlineRpcResult<"host.paths_exist">> {
  const entries = await Promise.all(
    command.paths.map(async (path) => [path, await pathExists(path)] as const),
  );
  return { existence: Object.fromEntries(entries) };
}

export async function readHostFile(
  command: CommandOf<"host.read_file">,
  options?: Pick<CommandDispatchOptions, "runtimeManager">,
): Promise<HostDaemonOnlineRpcResult<"host.read_file">> {
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
      ...userExecutableProcessOptions(
        options?.runtimeManager.getShellEnv() ?? {},
      ),
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
): Promise<HostDaemonOnlineRpcResult<"host.file_metadata">> {
  assertAbsoluteHostDiskPathCommand(command);
  return readFileMetadataForTransport({
    resolvedPath: command.path,
    resultPath: command.path,
    ...(command.rootPath !== undefined ? { rootPath: command.rootPath } : {}),
  });
}

export async function readHostRelativeFile(
  command: CommandOf<"host.read_file_relative">,
): Promise<HostDaemonOnlineRpcResult<"host.read_file_relative">> {
  return readRootRelativeFileForTransport({
    rootPath: command.rootPath,
    relativePath: command.path,
    dotfiles: command.dotfiles,
  });
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await fs.stat(path);
    return true;
  } catch (error) {
    if (
      isFsErrorWithCode(error, "ENOENT") ||
      isFsErrorWithCode(error, "ENOTDIR")
    ) {
      return false;
    }
    return true;
  }
}
