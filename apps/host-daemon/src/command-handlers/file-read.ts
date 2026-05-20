import { isUtf8 } from "node:buffer";
import fs from "node:fs/promises";
import path from "node:path";
import mimeTypes from "mime-types";
import type { HostReadFileRelativeDotfilePolicy } from "@bb/host-daemon-contract";
import { readGitBlob, WorkspaceError } from "@bb/host-workspace";
import {
  CommandDispatchError,
  ExpectedCommandDispatchError,
} from "../command-dispatch-support.js";
import { isFsErrorWithCode } from "../fs-errors.js";
import { resolveNonSymlinkDirectoryPath } from "./root-path.js";

const IMAGE_FILE_SIZE_LIMIT_BYTES = 10 * 1024 * 1024;
const NON_IMAGE_FILE_SIZE_LIMIT_BYTES = 25 * 1024 * 1024;

type FileContentEncoding = "base64" | "utf8";

export interface ReadFileForTransportResult {
  content: string;
  contentEncoding: FileContentEncoding;
  mimeType?: string;
  path: string;
  sizeBytes: number;
}

export interface ReadFileMetadataForTransportResult {
  modifiedAtMs: number;
  path: string;
  sizeBytes: number;
}

export interface ReadFileForTransportArgs {
  resolvedPath: string;
  resultPath: string;
  rootPath?: string;
}

export interface ReadRootRelativeFileForTransportArgs {
  rootPath: string;
  relativePath: string;
  dotfiles: HostReadFileRelativeDotfilePolicy;
}

interface ResolveRootPathForReadArgs {
  resultPath: string;
  rootPath: string;
}

interface ValidateRootRelativePathArgs {
  relativePath: string;
  dotfiles: HostReadFileRelativeDotfilePolicy;
}

interface ValidatedRootRelativePath {
  segments: readonly string[];
  resultPath: string;
}

export interface ReadFileFromGitRefArgs {
  /** Repo root — `git -C <rootPath>` runs from here. Must be absolute. */
  rootPath: string;
  /** Path under rootPath the caller asked about. Must be absolute, must be within rootPath. */
  resolvedPath: string;
  /** Path string echoed back in the result + used for mime-type lookup. */
  resultPath: string;
  /** Git ref to read from (e.g. "HEAD", a SHA, "main"). Caller should sanitize. */
  ref: string;
}

function isBinaryImageMimeType(mimeType?: string): boolean {
  return Boolean(
    mimeType && mimeType.startsWith("image/") && mimeType !== "image/svg+xml",
  );
}

function getFileSizeLimitBytes(mimeType?: string): number {
  return isBinaryImageMimeType(mimeType)
    ? IMAGE_FILE_SIZE_LIMIT_BYTES
    : NON_IMAGE_FILE_SIZE_LIMIT_BYTES;
}

function isPathWithinRoot(candidatePath: string, rootPath: string): boolean {
  const relativePath = path.relative(rootPath, candidatePath);
  return (
    relativePath === "" ||
    (!relativePath.startsWith("..") && !path.isAbsolute(relativePath))
  );
}

function getContentEncoding(
  fileContents: Buffer,
  mimeType?: string,
): FileContentEncoding {
  if (isBinaryImageMimeType(mimeType)) {
    return "base64";
  }

  if (isUtf8(fileContents)) {
    return "utf8";
  }
  return "base64";
}

function createMissingTargetError(
  resultPath: string,
): ExpectedCommandDispatchError {
  return new ExpectedCommandDispatchError(
    "ENOENT",
    `Path does not exist: ${resultPath}`,
  );
}

function createMissingPathError(resultPath: string): CommandDispatchError {
  return new CommandDispatchError(
    "ENOENT",
    `Path does not exist: ${resultPath}`,
  );
}

function createDotfileDeniedError(
  resultPath: string,
): ExpectedCommandDispatchError {
  return new ExpectedCommandDispatchError(
    "ENOENT",
    `Path does not exist: ${resultPath}`,
  );
}

function validateRootRelativePath(
  args: ValidateRootRelativePathArgs,
): ValidatedRootRelativePath {
  if (
    args.relativePath.includes("\0") ||
    args.relativePath.includes("\\") ||
    path.posix.isAbsolute(args.relativePath)
  ) {
    throw new CommandDispatchError("invalid_path", "Path must be relative");
  }

  const segments = args.relativePath.split("/");
  if (
    segments.some(
      (segment) => segment.length === 0 || segment === "." || segment === "..",
    )
  ) {
    throw new CommandDispatchError("invalid_path", "Path must be relative");
  }

  if (
    args.dotfiles === "deny" &&
    segments.some((segment) => segment.startsWith("."))
  ) {
    throw createDotfileDeniedError(args.relativePath);
  }

  return {
    segments,
    resultPath: segments.join("/"),
  };
}

async function resolveRootPathOrThrowMissingPath(
  args: ResolveRootPathForReadArgs,
): Promise<string> {
  try {
    return await resolveNonSymlinkDirectoryPath({
      description: "Root path",
      path: args.rootPath,
    });
  } catch (error) {
    if (isFsErrorWithCode(error, "ENOENT")) {
      throw createMissingPathError(args.resultPath);
    }
    throw error;
  }
}

async function throwMissingTargetOrRethrow(
  args: ReadFileForTransportArgs,
  error: unknown,
): Promise<never> {
  if (!isFsErrorWithCode(error, "ENOENT")) {
    throw error;
  }

  const rootPath = args.rootPath;
  if (!rootPath) {
    throw createMissingTargetError(args.resultPath);
  }

  await resolveRootPathOrThrowMissingPath({
    resultPath: args.resultPath,
    rootPath,
  });

  throw createMissingTargetError(args.resultPath);
}

async function resolveReadablePath(
  args: ReadFileForTransportArgs,
): Promise<string> {
  const rootPath = args.rootPath;
  if (!rootPath) {
    return args.resolvedPath;
  }

  const realRootPath = await resolveRootPathOrThrowMissingPath({
    resultPath: args.resultPath,
    rootPath,
  });
  const realResolvedPath = await fs
    .realpath(args.resolvedPath)
    .catch((error: unknown) => throwMissingTargetOrRethrow(args, error));
  if (!isPathWithinRoot(realResolvedPath, realRootPath)) {
    throw new CommandDispatchError(
      "invalid_path",
      `Path "${args.resultPath}" escapes read root`,
    );
  }

  return realResolvedPath;
}

/**
 * Read a file's contents at a specific git ref via `git cat-file`. Mirrors
 * `readFileForTransport`'s result shape (same caps, same utf-8/base64
 * detection, same `file_too_large` throw) so callers can treat disk and
 * git-ref reads identically.
 *
 * When the object does not exist at the ref (e.g. the file did not exist at
 * that ref, or the path was renamed and the caller passed the new name with
 * an old ref), returns empty content rather than throwing — the caller
 * decides whether "no context on this side" is meaningful.
 */
export async function readFileFromGitRef(
  args: ReadFileFromGitRefArgs,
): Promise<ReadFileForTransportResult> {
  if (!path.isAbsolute(args.rootPath)) {
    throw new CommandDispatchError("invalid_path", "rootPath must be absolute");
  }
  if (!path.isAbsolute(args.resolvedPath)) {
    throw new CommandDispatchError("invalid_path", "Path must be absolute");
  }
  const relativePath = path.relative(args.rootPath, args.resolvedPath);
  if (
    relativePath === "" ||
    relativePath.startsWith("..") ||
    path.isAbsolute(relativePath)
  ) {
    throw new CommandDispatchError(
      "invalid_path",
      `Path "${args.resultPath}" escapes read root`,
    );
  }
  // `git cat-file` is happy with `\` on Windows but `<ref>:<path>` syntax wants
  // forward slashes regardless of host OS — normalize once here.
  const gitRelativePath = relativePath.split(path.sep).join("/");
  const mimeType = mimeTypes.lookup(args.resultPath) || undefined;
  const fileSizeLimitBytes = getFileSizeLimitBytes(mimeType);

  let blob;
  try {
    blob = await readGitBlob(
      args.rootPath,
      args.ref,
      gitRelativePath,
      fileSizeLimitBytes,
    );
  } catch (error) {
    if (error instanceof WorkspaceError && error.code === "blob_too_large") {
      throw new CommandDispatchError("file_too_large", error.message);
    }
    throw error;
  }

  if (blob.contents === null) {
    return {
      path: args.resultPath,
      content: "",
      contentEncoding: "utf8",
      ...(mimeType ? { mimeType } : {}),
      sizeBytes: 0,
    };
  }

  const contentEncoding = getContentEncoding(blob.contents, mimeType);
  return {
    path: args.resultPath,
    content:
      contentEncoding === "utf8"
        ? blob.contents.toString("utf8")
        : blob.contents.toString("base64"),
    contentEncoding,
    ...(mimeType ? { mimeType } : {}),
    sizeBytes: blob.sizeBytes,
  };
}

export async function readFileForTransport(
  args: ReadFileForTransportArgs,
): Promise<ReadFileForTransportResult> {
  const readablePath = await resolveReadablePath(args);
  const stat = await fs
    .stat(readablePath)
    .catch((error: unknown) => throwMissingTargetOrRethrow(args, error));
  if (stat.isDirectory()) {
    throw new CommandDispatchError(
      "invalid_path",
      "Path is a directory, not a file",
    );
  }

  const mimeType = mimeTypes.lookup(args.resultPath) || undefined;
  const fileSizeLimitBytes = getFileSizeLimitBytes(mimeType);
  if (stat.size > fileSizeLimitBytes) {
    throw new CommandDispatchError(
      "file_too_large",
      `File size ${stat.size} bytes exceeds the ${Math.floor(fileSizeLimitBytes / (1024 * 1024))} MB limit`,
    );
  }

  const fileContents = await fs
    .readFile(readablePath)
    .catch((error: unknown) => throwMissingTargetOrRethrow(args, error));
  const contentEncoding = getContentEncoding(fileContents, mimeType);
  return {
    path: args.resultPath,
    content:
      contentEncoding === "utf8"
        ? fileContents.toString("utf8")
        : fileContents.toString("base64"),
    contentEncoding,
    ...(mimeType ? { mimeType } : {}),
    sizeBytes: stat.size,
  };
}

export async function readRootRelativeFileForTransport(
  args: ReadRootRelativeFileForTransportArgs,
): Promise<ReadFileForTransportResult> {
  if (!path.isAbsolute(args.rootPath)) {
    throw new CommandDispatchError("invalid_path", "rootPath must be absolute");
  }

  const relativePath = validateRootRelativePath({
    relativePath: args.relativePath,
    dotfiles: args.dotfiles,
  });
  const resolvedPath = path.join(args.rootPath, ...relativePath.segments);
  const readArgs: ReadFileForTransportArgs = {
    resolvedPath,
    resultPath: relativePath.resultPath,
    rootPath: args.rootPath,
  };
  const readablePath = await resolveReadablePath(readArgs);
  const stat = await fs
    .stat(readablePath)
    .catch((error: unknown) => throwMissingTargetOrRethrow(readArgs, error));
  if (stat.isDirectory()) {
    throw new CommandDispatchError(
      "invalid_path",
      "Path is a directory, not a file",
    );
  }

  const mimeType = mimeTypes.lookup(relativePath.resultPath) || undefined;
  const fileContents = await fs
    .readFile(readablePath)
    .catch((error: unknown) => throwMissingTargetOrRethrow(readArgs, error));
  const contentEncoding = getContentEncoding(fileContents, mimeType);
  return {
    path: relativePath.resultPath,
    content:
      contentEncoding === "utf8"
        ? fileContents.toString("utf8")
        : fileContents.toString("base64"),
    contentEncoding,
    ...(mimeType ? { mimeType } : {}),
    sizeBytes: stat.size,
  };
}

export async function readFileMetadataForTransport(
  args: ReadFileForTransportArgs,
): Promise<ReadFileMetadataForTransportResult> {
  const readablePath = await resolveReadablePath(args);
  const stat = await fs
    .stat(readablePath)
    .catch((error: unknown) => throwMissingTargetOrRethrow(args, error));
  if (stat.isDirectory()) {
    throw new CommandDispatchError(
      "invalid_path",
      "Path is a directory, not a file",
    );
  }

  return {
    path: args.resultPath,
    modifiedAtMs: stat.mtimeMs,
    sizeBytes: stat.size,
  };
}
