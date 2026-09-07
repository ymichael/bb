import { WorkspaceError } from "bb-environment-provider-host/git";
import path from "node:path";

const REPO_DIR_NAME_PATTERN = /^[A-Za-z0-9._][A-Za-z0-9._-]*$/;

function tryParseUrlPath(value: string): string | null {
  try {
    const url = new URL(value);
    if (
      url.protocol === "http:" ||
      url.protocol === "https:" ||
      url.protocol === "ssh:"
    ) {
      return url.pathname;
    }
  } catch {}
  return null;
}

export function deriveRepoDirName(sourcePath: string): string {
  const trimmed = sourcePath.replace(/\/+$/, "");

  const scpMatch = /^[^:/]+@[^:]+:(?<path>.+)$/.exec(trimmed);
  const pathPart =
    scpMatch?.groups?.path ?? tryParseUrlPath(trimmed) ?? trimmed;

  const basename = path.posix.basename(pathPart);
  const candidate = basename.endsWith(".git")
    ? basename.slice(0, -".git".length)
    : basename;

  if (
    !candidate ||
    candidate === "." ||
    candidate === ".." ||
    !REPO_DIR_NAME_PATTERN.test(candidate)
  ) {
    throw new WorkspaceError(
      "invalid_source_path",
      `Cannot derive repository directory name from source "${sourcePath}"`,
    );
  }
  return candidate;
}

export function resolveWorktreesRoot(dataDir: string): string {
  return path.posix.join(dataDir, "worktrees");
}

export function resolveWorktreeAttemptRoot(args: {
  dataDir: string;
  pathKey: string;
}): string {
  if (
    args.pathKey === "." ||
    args.pathKey === ".." ||
    path.posix.basename(args.pathKey) !== args.pathKey
  ) {
    throw new WorkspaceError(
      "invalid_path_key",
      "A worktree path key must be a single path segment",
    );
  }
  return path.posix.join(resolveWorktreesRoot(args.dataDir), args.pathKey);
}

export function resolveWorktreeTargetPath(args: {
  dataDir: string;
  pathKey: string;
  sourcePath: string;
}): string {
  return path.posix.join(
    resolveWorktreeAttemptRoot(args),
    deriveRepoDirName(args.sourcePath),
  );
}
