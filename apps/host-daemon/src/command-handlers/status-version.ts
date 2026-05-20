import { createHash } from "node:crypto";
import type { BigIntStats, Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type {
  HostDaemonCommandResult,
  HostReadFileRelativeDotfilePolicy,
  HostStatusVersionFileSource,
  HostStatusVersionFolderSource,
  HostStatusVersionSource,
} from "@bb/host-daemon-contract";
import { CommandDispatchError } from "../command-dispatch-support.js";
import type { CommandOf } from "../command-dispatch-support.js";
import { isFsErrorWithCode } from "../fs-errors.js";
import { resolveNonSymlinkDirectoryPath } from "./root-path.js";

type StatusVersionHashEntry =
  | StatusVersionFileEntry
  | StatusVersionUnreadableEntry;

interface StatusVersionFileEntry {
  kind: "file";
  modifiedAtNs: bigint;
  path: string;
  sizeBytes: bigint;
}

interface StatusVersionUnreadableEntry {
  kind: "unreadable";
  path: string;
}

interface ValidatedRelativePath {
  resultPath: string;
  segments: readonly string[];
}

interface ResolveSourceFileArgs {
  dotfiles: HostReadFileRelativeDotfilePolicy;
  path: string;
  rootPath: string;
}

interface WalkDirectoryArgs {
  dotfiles: HostReadFileRelativeDotfilePolicy;
  physicalDirPath: string;
  relativeDirPath: string;
  rootPath: string;
  seenDirectories: Set<string>;
}

type WalkEntryResolution =
  | { kind: "directory"; readablePath: string }
  | { kind: "file"; entry: StatusVersionFileEntry }
  | { kind: "skip" };

interface ResolveReadablePathArgs {
  fullPath: string;
  resultPath: string;
  rootPath: string;
}

interface StatReadableFileArgs {
  readablePath: string;
  resultPath: string;
}

interface ResolveWalkEntryArgs {
  fullPath: string;
  relativePath: string;
  rootPath: string;
}

const UNREADABLE_DIRECTORY_PATH = ".";
const UNREADABLE_DIRECTORY_HASH_SENTINEL = "unreadable-directory";

const STATUS_SOURCE_UNUSABLE_ERROR_CODES = new Set([
  "EACCES",
  "ELOOP",
  "ENOENT",
  "ENOTDIR",
  "EPERM",
  "invalid_path",
]);

function validateRelativePath(
  relativePath: string,
  dotfiles: HostReadFileRelativeDotfilePolicy,
): ValidatedRelativePath {
  if (
    relativePath.includes("\0") ||
    relativePath.includes("\\") ||
    path.posix.isAbsolute(relativePath)
  ) {
    throw new CommandDispatchError("invalid_path", "Path must be relative");
  }

  const segments = relativePath.split("/");
  if (
    segments.some(
      (segment) => segment.length === 0 || segment === "." || segment === "..",
    )
  ) {
    throw new CommandDispatchError("invalid_path", "Path must be relative");
  }

  if (
    dotfiles === "deny" &&
    segments.some((segment) => segment.startsWith("."))
  ) {
    throw new CommandDispatchError(
      "ENOENT",
      `Path does not exist: ${relativePath}`,
    );
  }

  return {
    resultPath: segments.join("/"),
    segments,
  };
}

function assertAbsoluteRootPath(rootPath: string): void {
  if (!path.isAbsolute(rootPath)) {
    throw new CommandDispatchError("invalid_path", "rootPath must be absolute");
  }
}

function isPathWithinRoot(candidatePath: string, rootPath: string): boolean {
  const relativePath = path.relative(rootPath, candidatePath);
  return (
    relativePath === "" ||
    (!relativePath.startsWith("..") && !path.isAbsolute(relativePath))
  );
}

function isUnavailableStatusSourceError(error: Error): boolean {
  return (
    error instanceof CommandDispatchError &&
    STATUS_SOURCE_UNUSABLE_ERROR_CODES.has(error.code)
  );
}

function toMappedFsError(error: Error, resultPath: string): Error {
  if (isFsErrorWithCode(error, "ENOENT")) {
    return new CommandDispatchError(
      "ENOENT",
      `Path does not exist: ${resultPath}`,
    );
  }
  if (isFsErrorWithCode(error, "ENOTDIR")) {
    return new CommandDispatchError(
      "ENOTDIR",
      `Path is not a directory: ${resultPath}`,
    );
  }
  if (isFsErrorWithCode(error, "EACCES")) {
    return new CommandDispatchError(
      "EACCES",
      `Permission denied: ${resultPath}`,
    );
  }
  if (isFsErrorWithCode(error, "EPERM")) {
    return new CommandDispatchError(
      "EPERM",
      `Operation not permitted: ${resultPath}`,
    );
  }
  if (isFsErrorWithCode(error, "ELOOP")) {
    return new CommandDispatchError(
      "ELOOP",
      `Too many symbolic links: ${resultPath}`,
    );
  }
  return error;
}

function throwMappedFsError(error: Error, resultPath: string): never {
  throw toMappedFsError(error, resultPath);
}

async function resolveStatusRootPath(rootPath: string): Promise<string> {
  assertAbsoluteRootPath(rootPath);
  try {
    return await resolveNonSymlinkDirectoryPath({
      description: "Root path",
      path: rootPath,
    });
  } catch (error) {
    if (error instanceof Error) {
      throwMappedFsError(error, rootPath);
    }
    throw error;
  }
}

async function resolveReadablePath(
  args: ResolveReadablePathArgs,
): Promise<string> {
  try {
    const readablePath = await fs.realpath(args.fullPath);
    if (!isPathWithinRoot(readablePath, args.rootPath)) {
      throw new CommandDispatchError(
        "invalid_path",
        `Path "${args.resultPath}" escapes read root`,
      );
    }
    return readablePath;
  } catch (error) {
    if (error instanceof Error) {
      throwMappedFsError(error, args.resultPath);
    }
    throw error;
  }
}

async function statReadableFile(
  args: StatReadableFileArgs,
): Promise<StatusVersionFileEntry> {
  try {
    const stat = await fs.stat(args.readablePath, { bigint: true });
    if (stat.isDirectory()) {
      throw new CommandDispatchError(
        "invalid_path",
        "Path is a directory, not a file",
      );
    }
    return {
      kind: "file",
      modifiedAtNs: stat.mtimeNs,
      path: args.resultPath,
      sizeBytes: stat.size,
    };
  } catch (error) {
    if (error instanceof Error) {
      throwMappedFsError(error, args.resultPath);
    }
    throw error;
  }
}

async function resolveWalkEntry(
  args: ResolveWalkEntryArgs,
): Promise<WalkEntryResolution> {
  let readablePath: string;
  try {
    readablePath = await resolveReadablePath({
      fullPath: args.fullPath,
      resultPath: args.relativePath,
      rootPath: args.rootPath,
    });
  } catch (error) {
    if (error instanceof Error && isUnavailableStatusSourceError(error)) {
      return { kind: "skip" };
    }
    throw error;
  }

  let stat: BigIntStats;
  try {
    stat = await fs.stat(readablePath, { bigint: true });
  } catch (error) {
    if (error instanceof Error) {
      try {
        throwMappedFsError(error, args.relativePath);
      } catch (mappedError) {
        if (
          mappedError instanceof Error &&
          isUnavailableStatusSourceError(mappedError)
        ) {
          return { kind: "skip" };
        }
        throw mappedError;
      }
    }
    throw error;
  }

  if (stat.isDirectory()) {
    return { kind: "directory", readablePath };
  }
  if (stat.isFile()) {
    return {
      kind: "file",
      entry: {
        kind: "file",
        modifiedAtNs: stat.mtimeNs,
        path: args.relativePath,
        sizeBytes: stat.size,
      },
    };
  }
  return { kind: "skip" };
}

async function statRelativeFile(
  args: ResolveSourceFileArgs,
): Promise<StatusVersionFileEntry> {
  const rootPath = await resolveStatusRootPath(args.rootPath);
  const relativePath = validateRelativePath(args.path, args.dotfiles);
  const readablePath = await resolveReadablePath({
    fullPath: path.join(rootPath, ...relativePath.segments),
    resultPath: relativePath.resultPath,
    rootPath,
  });
  return statReadableFile({
    readablePath,
    resultPath: relativePath.resultPath,
  });
}

function toChildRelativePath(
  relativeDirPath: string,
  childName: string,
): string {
  return relativeDirPath.length === 0
    ? childName
    : `${relativeDirPath}/${childName}`;
}

async function walkDirectory(
  args: WalkDirectoryArgs,
): Promise<StatusVersionHashEntry[]> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(args.physicalDirPath, { withFileTypes: true });
  } catch (error) {
    if (error instanceof Error) {
      const mappedError = toMappedFsError(
        error,
        args.relativeDirPath || args.rootPath,
      );
      if (
        mappedError instanceof Error &&
        isUnavailableStatusSourceError(mappedError)
      ) {
        return [
          {
            kind: "unreadable",
            path: args.relativeDirPath || UNREADABLE_DIRECTORY_PATH,
          },
        ];
      }
      throw mappedError;
    }
    throw error;
  }

  const fileEntries: StatusVersionHashEntry[] = [];
  for (const entry of entries) {
    if (args.dotfiles === "deny" && entry.name.startsWith(".")) {
      continue;
    }

    const relativePath = toChildRelativePath(args.relativeDirPath, entry.name);
    try {
      validateRelativePath(relativePath, args.dotfiles);
    } catch (error) {
      if (error instanceof Error && isUnavailableStatusSourceError(error)) {
        continue;
      }
      throw error;
    }
    const resolvedEntry = await resolveWalkEntry({
      fullPath: path.join(args.physicalDirPath, entry.name),
      relativePath,
      rootPath: args.rootPath,
    });
    if (resolvedEntry.kind === "skip") {
      continue;
    }

    if (resolvedEntry.kind === "directory") {
      if (args.seenDirectories.has(resolvedEntry.readablePath)) {
        continue;
      }
      args.seenDirectories.add(resolvedEntry.readablePath);
      fileEntries.push(
        ...(await walkDirectory({
          ...args,
          physicalDirPath: resolvedEntry.readablePath,
          relativeDirPath: relativePath,
        })),
      );
      continue;
    }

    fileEntries.push(resolvedEntry.entry);
  }

  return fileEntries;
}

function hashStatusVersion(
  source: HostStatusVersionSource,
  entries: readonly StatusVersionHashEntry[],
): string {
  const hash = createHash("sha256");
  hash.update(`source:${source}\n`);
  for (const entry of [...entries].sort((left, right) =>
    left.path.localeCompare(right.path),
  )) {
    if (entry.kind === "unreadable") {
      // Keep unreadable child directories in the tuple so STATUS folder mode
      // stays aligned with /status/ when index.html is still valid.
      hash.update(`${entry.path}\0${UNREADABLE_DIRECTORY_HASH_SENTINEL}\n`);
      continue;
    }
    hash.update(
      `${entry.path}\0${entry.sizeBytes.toString()}\0${entry.modifiedAtNs.toString()}\n`,
    );
  }
  return hash.digest("hex");
}

async function resolveFolderSource(
  source: HostStatusVersionFolderSource,
): Promise<HostDaemonCommandResult<"host.status_version">> {
  await statRelativeFile({
    rootPath: source.rootPath,
    path: source.indexPath,
    dotfiles: source.dotfiles,
  });

  const rootPath = await resolveStatusRootPath(source.rootPath);
  const entries = await walkDirectory({
    rootPath,
    physicalDirPath: rootPath,
    relativeDirPath: "",
    dotfiles: source.dotfiles,
    seenDirectories: new Set([rootPath]),
  });
  return {
    source: source.source,
    hash: hashStatusVersion(source.source, entries),
  };
}

async function resolveFileSource(
  source: HostStatusVersionFileSource,
): Promise<HostDaemonCommandResult<"host.status_version">> {
  const entry = await statRelativeFile({
    rootPath: source.rootPath,
    path: source.path,
    dotfiles: source.dotfiles,
  });
  return {
    source: source.source,
    hash: hashStatusVersion(source.source, [entry]),
  };
}

async function tryResolveFolderSource(
  source: HostStatusVersionFolderSource,
): Promise<HostDaemonCommandResult<"host.status_version"> | null> {
  try {
    return await resolveFolderSource(source);
  } catch (error) {
    if (error instanceof Error && isUnavailableStatusSourceError(error)) {
      return null;
    }
    throw error;
  }
}

async function tryResolveFileSource(
  source: HostStatusVersionFileSource,
): Promise<HostDaemonCommandResult<"host.status_version"> | null> {
  try {
    return await resolveFileSource(source);
  } catch (error) {
    if (error instanceof Error && isUnavailableStatusSourceError(error)) {
      return null;
    }
    throw error;
  }
}

export async function readHostStatusVersion(
  command: CommandOf<"host.status_version">,
): Promise<HostDaemonCommandResult<"host.status_version">> {
  const [folderSource, htmlSource, markdownSource] = command.sources;
  return (
    (await tryResolveFolderSource(folderSource)) ??
    (await tryResolveFileSource(htmlSource)) ??
    (await tryResolveFileSource(markdownSource)) ?? {
      source: "empty",
      hash: hashStatusVersion("empty", []),
    }
  );
}
