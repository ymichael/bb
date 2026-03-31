import { isUtf8 } from "node:buffer";
import fs from "node:fs/promises";
import path from "node:path";
import mimeTypes from "mime-types";
import { CommandDispatchError } from "../command-dispatch-support.js";
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

export interface ReadFileForTransportArgs {
  resolvedPath: string;
  resultPath: string;
  rootPath?: string;
}

function isBinaryImageMimeType(mimeType?: string): boolean {
  return Boolean(
    mimeType &&
    mimeType.startsWith("image/") &&
    mimeType !== "image/svg+xml",
  );
}

function getFileSizeLimitBytes(mimeType?: string): number {
  return isBinaryImageMimeType(mimeType)
    ? IMAGE_FILE_SIZE_LIMIT_BYTES
    : NON_IMAGE_FILE_SIZE_LIMIT_BYTES;
}

function isPathWithinRoot(
  candidatePath: string,
  rootPath: string,
): boolean {
  const relativePath = path.relative(rootPath, candidatePath);
  return relativePath === "" ||
    (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
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

async function resolveReadablePath(
  args: ReadFileForTransportArgs,
): Promise<string> {
  if (!args.rootPath) {
    return args.resolvedPath;
  }

  const [realRootPath, realResolvedPath] = await Promise.all([
    resolveNonSymlinkDirectoryPath({
      description: "Root path",
      path: args.rootPath,
    }),
    fs.realpath(args.resolvedPath),
  ]);
  if (!isPathWithinRoot(realResolvedPath, realRootPath)) {
    throw new CommandDispatchError(
      "invalid_path",
      `Path "${args.resultPath}" escapes read root`,
    );
  }

  return realResolvedPath;
}

export async function readFileForTransport(
  args: ReadFileForTransportArgs,
): Promise<ReadFileForTransportResult> {
  try {
    const readablePath = await resolveReadablePath(args);
    const stat = await fs.stat(readablePath);
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

    const fileContents = await fs.readFile(readablePath);
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
  } catch (error) {
    if (isFsErrorWithCode(error, "ENOENT")) {
      throw new CommandDispatchError(
        "ENOENT",
        `Path does not exist: ${args.resultPath}`,
      );
    }
    throw error;
  }
}
