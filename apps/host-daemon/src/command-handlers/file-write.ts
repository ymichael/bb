import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { HostDaemonOnlineRpcResult } from "@bb/host-daemon-contract";
import { CommandDispatchError } from "../command-dispatch-support.js";
import type { CommandOf } from "../command-dispatch-support.js";
import { isFsErrorWithCode } from "../fs-errors.js";
import { sha256Hex } from "../sha256-hex.js";
import {
  createMissingTargetError,
  isPathWithinRoot,
  NON_IMAGE_FILE_SIZE_LIMIT_BYTES,
} from "./file-read.js";
import { resolveNonSymlinkDirectoryPath } from "./root-path.js";

const guardedWriteTails = new Map<string, Promise<void>>();

async function serializeGuardedWrite<T>(
  writePath: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = guardedWriteTails.get(writePath) ?? Promise.resolve();
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => gate);
  guardedWriteTails.set(writePath, tail);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (guardedWriteTails.get(writePath) === tail) {
      guardedWriteTails.delete(writePath);
    }
  }
}

interface ResolvedWriteTarget {
  writePath: string;
  parentMissing: boolean;
}

export async function resolveWriteTarget(
  resolvedPath: string,
  resultPath: string,
): Promise<ResolvedWriteTarget> {
  try {
    return { writePath: await fs.realpath(resolvedPath), parentMissing: false };
  } catch (error) {
    if (!isFsErrorWithCode(error, "ENOENT")) {
      throw error;
    }
  }

  const missingSegments = [path.basename(resolvedPath)];
  let ancestor = path.dirname(resolvedPath);
  for (;;) {
    try {
      const realAncestor = await fs.realpath(ancestor);
      return {
        writePath: path.join(realAncestor, ...missingSegments),
        parentMissing: missingSegments.length > 1,
      };
    } catch (error) {
      if (!isFsErrorWithCode(error, "ENOENT")) {
        throw error;
      }
    }
    const parent = path.dirname(ancestor);
    if (parent === ancestor) {
      throw createMissingTargetError(resultPath);
    }
    missingSegments.unshift(path.basename(ancestor));
    ancestor = parent;
  }
}

export async function writeHostFile(
  command: CommandOf<"host.write_file">,
): Promise<HostDaemonOnlineRpcResult<"host.write_file">> {
  if (!path.isAbsolute(command.path)) {
    throw new CommandDispatchError("invalid_path", "Path must be absolute");
  }
  if (command.rootPath !== undefined && !path.isAbsolute(command.rootPath)) {
    throw new CommandDispatchError("invalid_path", "rootPath must be absolute");
  }

  const contents = Buffer.from(command.content, command.contentEncoding);
  if (contents.length > NON_IMAGE_FILE_SIZE_LIMIT_BYTES) {
    throw new CommandDispatchError(
      "file_too_large",
      `File size ${contents.length} bytes exceeds the ${Math.floor(NON_IMAGE_FILE_SIZE_LIMIT_BYTES / (1024 * 1024))} MB limit`,
    );
  }

  const resolvedPath = path.resolve(command.path);
  const target = await resolveWriteTarget(resolvedPath, command.path);

  const write = () => writeResolvedHostFile(command, contents, target);
  return serializeGuardedWrite(target.writePath, write);
}

async function writeResolvedHostFile(
  command: CommandOf<"host.write_file">,
  contents: Buffer,
  target: ResolvedWriteTarget,
): Promise<HostDaemonOnlineRpcResult<"host.write_file">> {
  if (command.rootPath !== undefined) {
    let realRootPath: string;
    try {
      realRootPath = await resolveNonSymlinkDirectoryPath({
        description: "Root path",
        path: command.rootPath,
      });
    } catch (error) {
      if (isFsErrorWithCode(error, "ENOENT")) {
        throw createMissingTargetError(command.path);
      }
      throw error;
    }
    if (!isPathWithinRoot(target.writePath, realRootPath)) {
      throw new CommandDispatchError(
        "invalid_path",
        `Path "${command.path}" escapes write root`,
      );
    }
  }

  if (target.parentMissing && !command.createParents) {
    throw createMissingTargetError(path.dirname(command.path));
  }

  let currentContents: Buffer | null = null;
  let currentMode: number | undefined;
  try {
    const stat = await fs.stat(target.writePath);
    if (stat.isDirectory()) {
      throw new CommandDispatchError(
        "invalid_path",
        "Path is a directory, not a file",
      );
    }
    currentMode = stat.mode & 0o777;
    currentContents = await fs.readFile(target.writePath);
  } catch (error) {
    if (!isFsErrorWithCode(error, "ENOENT")) {
      throw error;
    }
  }
  const currentSha256 =
    currentContents === null ? null : sha256Hex(currentContents);

  if (
    command.expectedSha256 !== undefined &&
    command.expectedSha256 !== currentSha256
  ) {
    return { outcome: "conflict", currentSha256 };
  }

  if (command.createParents) {
    await fs.mkdir(path.dirname(target.writePath), { recursive: true });
  }
  const writeOptions = {
    ...(command.mode !== undefined
      ? { mode: command.mode }
      : currentMode !== undefined
        ? { mode: currentMode }
        : {}),
  };
  let temporaryPath: string | null = null;
  try {
    if (command.expectedSha256 === undefined) {
      await fs.writeFile(target.writePath, contents, writeOptions);
    } else {
      temporaryPath = `${target.writePath}.bb-write-${randomUUID()}`;
      const handle = await fs.open(temporaryPath, "wx", writeOptions.mode);
      try {
        await handle.writeFile(contents);
        await handle.sync();
      } finally {
        await handle.close();
      }

      if (command.expectedSha256 === null) {
        try {
          await fs.link(temporaryPath, target.writePath);
        } catch (error) {
          if (isFsErrorWithCode(error, "EEXIST")) {
            const latest = await fs
              .readFile(target.writePath)
              .catch(() => null);
            return {
              outcome: "conflict",
              currentSha256: latest === null ? null : sha256Hex(latest),
            };
          }
          throw error;
        }
      } else {
        const latest = await fs.readFile(target.writePath).catch(() => null);
        const latestSha256 = latest === null ? null : sha256Hex(latest);
        if (latestSha256 !== command.expectedSha256) {
          return { outcome: "conflict", currentSha256: latestSha256 };
        }
        await fs.rename(temporaryPath, target.writePath);
        temporaryPath = null;
      }
    }
  } catch (error) {
    if (isFsErrorWithCode(error, "ENOENT")) {
      throw createMissingTargetError(path.dirname(command.path));
    }
    if (
      isFsErrorWithCode(error, "ENOTDIR") ||
      isFsErrorWithCode(error, "EISDIR")
    ) {
      throw new CommandDispatchError(
        "invalid_path",
        `Cannot write file at ${command.path}`,
      );
    }
    throw error;
  } finally {
    if (temporaryPath !== null) {
      await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
    }
  }

  return {
    outcome: "written",
    sha256: sha256Hex(contents),
    sizeBytes: contents.length,
  };
}
