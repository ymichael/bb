import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { WORKTREE_INCLUDE_FILE_NAME } from "@bb/domain";
import { runGit, WorkspaceError } from "./git.js";

interface CopyWorktreeIncludeFilesArgs {
  sourcePath: string;
  targetPath: string;
  shellPath?: string;
  signal?: AbortSignal;
}

export interface CopyWorktreeIncludeFilesResult {
  ran: boolean;
  copied: string[];
  skipped: string[];
}

const EMPTY_RESULT: CopyWorktreeIncludeFilesResult = {
  ran: false,
  copied: [],
  skipped: [],
};

function hasPattern(contents: string): boolean {
  return contents
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .some((line) => line.length > 0 && !line.startsWith("#"));
}

function isMissingFileError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

async function readIncludeFile(sourcePath: string): Promise<string | null> {
  try {
    return await fs.readFile(
      path.join(sourcePath, WORKTREE_INCLUDE_FILE_NAME),
      "utf8",
    );
  } catch (error) {
    if (isMissingFileError(error)) {
      return null;
    }
    throw error;
  }
}

async function listMatchingFiles(
  sourcePath: string,
  shellPath: string | undefined,
  signal: AbortSignal | undefined,
): Promise<string[]> {
  const result = await runGit(
    [
      "ls-files",
      "--others",
      "--ignored",
      `--exclude-from=${WORKTREE_INCLUDE_FILE_NAME}`,
      "-z",
    ],
    {
      cwd: sourcePath,
      ...(shellPath !== undefined ? { shellPath } : {}),
      signal,
    },
  );
  return result.stdout.split("\0").filter(Boolean);
}

async function pathPresent(targetPath: string): Promise<boolean> {
  try {
    await fs.lstat(targetPath);
    return true;
  } catch (error) {
    if (isMissingFileError(error)) {
      return false;
    }
    throw error;
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new WorkspaceError(
      "provision_cancelled",
      "Workspace provisioning was cancelled",
      { cause: signal.reason },
    );
  }
}

function isInside(parentRealPath: string, childRealPath: string): boolean {
  const relative = path.relative(parentRealPath, childRealPath);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

export async function copyWorktreeIncludeFiles(
  args: CopyWorktreeIncludeFilesArgs,
): Promise<CopyWorktreeIncludeFilesResult> {
  const contents = await readIncludeFile(args.sourcePath);
  if (contents === null || !hasPattern(contents)) {
    return EMPTY_RESULT;
  }

  const relativePaths = await listMatchingFiles(
    args.sourcePath,
    args.shellPath,
    args.signal,
  );
  if (relativePaths.length === 0) {
    return { ran: true, copied: [], skipped: [] };
  }

  let targetRealPath: string;
  try {
    targetRealPath = await fs.realpath(args.targetPath);
  } catch (error) {
    return {
      ran: true,
      copied: [],
      skipped: [`${args.targetPath}: ${describeError(error)}`],
    };
  }

  const copied: string[] = [];
  const skipped: string[] = [];
  for (const relativePath of relativePaths) {
    throwIfAborted(args.signal);
    const sourceFile = path.join(args.sourcePath, relativePath);
    const targetFile = path.join(targetRealPath, relativePath);
    try {
      const stats = await fs.lstat(sourceFile);
      if (stats.isSymbolicLink()) {
        skipped.push(`${relativePath}: symlink`);
        continue;
      }
      if (await pathPresent(targetFile)) {
        skipped.push(`${relativePath}: already exists in the worktree`);
        continue;
      }
      await fs.mkdir(path.dirname(targetFile), { recursive: true });
      const parentRealPath = await fs.realpath(path.dirname(targetFile));
      if (!isInside(targetRealPath, parentRealPath)) {
        skipped.push(`${relativePath}: destination escapes the worktree`);
        continue;
      }
      await fs.copyFile(sourceFile, targetFile, fsConstants.COPYFILE_EXCL);
      copied.push(relativePath);
    } catch (error) {
      skipped.push(`${relativePath}: ${describeError(error)}`);
    }
  }

  return { ran: true, copied, skipped };
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
