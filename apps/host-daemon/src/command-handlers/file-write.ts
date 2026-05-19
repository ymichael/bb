import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { HOST_WRITE_FILE_MAX_BYTES } from "@bb/host-daemon-contract";
import { CommandDispatchError } from "../command-dispatch-support.js";
import { isFsErrorWithCode } from "../fs-errors.js";
import { resolveNonSymlinkDirectoryPath } from "./root-path.js";

export interface WriteFileUnderRootArgs {
  rootPath: string;
  resolvedPath: string;
  resultPath: string;
  content: string;
  contentEncoding: "utf8" | "base64";
}

export interface WriteFileUnderRootResult {
  path: string;
  sizeBytes: number;
}

function decodeBody(
  content: string,
  contentEncoding: "utf8" | "base64",
): Buffer {
  if (contentEncoding === "base64") {
    return Buffer.from(content, "base64");
  }
  return Buffer.from(content, "utf8");
}

function isPathWithinRoot(candidatePath: string, rootPath: string): boolean {
  const relativePath = path.relative(rootPath, candidatePath);
  return (
    relativePath !== "" &&
    !relativePath.startsWith("..") &&
    !path.isAbsolute(relativePath)
  );
}

export async function writeFileUnderRoot(
  args: WriteFileUnderRootArgs,
): Promise<WriteFileUnderRootResult> {
  if (!path.isAbsolute(args.rootPath)) {
    throw new CommandDispatchError("invalid_path", "rootPath must be absolute");
  }
  if (!path.isAbsolute(args.resolvedPath)) {
    throw new CommandDispatchError("invalid_path", "Path must be absolute");
  }

  const body = decodeBody(args.content, args.contentEncoding);
  if (body.byteLength > HOST_WRITE_FILE_MAX_BYTES) {
    throw new CommandDispatchError(
      "file_too_large",
      `Payload ${body.byteLength} bytes exceeds the ${HOST_WRITE_FILE_MAX_BYTES} byte limit`,
    );
  }

  const realRootPath = await resolveNonSymlinkDirectoryPath({
    description: "Root path",
    path: args.rootPath,
  }).catch((error: unknown) => {
    if (isFsErrorWithCode(error, "ENOENT")) {
      throw new CommandDispatchError(
        "ENOENT",
        `Root path does not exist: ${args.rootPath}`,
      );
    }
    throw error;
  });

  // The target file does not exist yet, so we cannot realpath it directly.
  // Instead realpath its parent directory and compare that. This covers macOS
  // `/tmp` → `/private/tmp` symlinks and any other intermediate symlinks
  // between caller-supplied paths and the on-disk root.
  const parentDir = path.dirname(args.resolvedPath);
  const realParentDir = await resolveNonSymlinkDirectoryPath({
    description: "Parent directory",
    path: parentDir,
  }).catch((error: unknown) => {
    if (isFsErrorWithCode(error, "ENOENT")) {
      throw new CommandDispatchError(
        "ENOENT",
        `Parent directory does not exist: ${parentDir}`,
      );
    }
    throw error;
  });
  const realResolvedPath = path.join(realParentDir, path.basename(args.resolvedPath));

  if (
    realResolvedPath !== realRootPath &&
    !isPathWithinRoot(realResolvedPath, realRootPath)
  ) {
    throw new CommandDispatchError(
      "invalid_path",
      `Path "${args.resultPath}" escapes write root`,
    );
  }

  const tmpName = `.bb-write-${randomBytes(6).toString("hex")}.tmp`;
  const tmpPath = path.join(realParentDir, tmpName);
  try {
    await fs.writeFile(tmpPath, body, { mode: 0o600 });
    await fs.rename(tmpPath, realResolvedPath);
  } catch (error) {
    await fs.unlink(tmpPath).catch(() => undefined);
    throw error;
  }

  return {
    path: args.resultPath,
    sizeBytes: body.byteLength,
  };
}
