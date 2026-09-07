import path from "node:path";

export const WORKSPACES_DIR_NAME = "workspaces";

export const CORE_WORKSPACES_DIR_NAME = "personal-workspaces";

export class PersonalWorkspacePathError extends Error {}

function isSinglePathSegment(value: string): boolean {
  return (
    value.length > 0 &&
    value !== "." &&
    value !== ".." &&
    path.basename(value) === value
  );
}

export function resolveWorkspacePath(args: {
  dataDir: string;
  pathKey: string;
}): string {
  if (!isSinglePathSegment(args.pathKey)) {
    throw new PersonalWorkspacePathError(
      `Personal workspace key must be a single path segment: ${args.pathKey}`,
    );
  }
  return path.posix.join(args.dataDir, WORKSPACES_DIR_NAME, args.pathKey);
}

export function assertRemovableWorkspacePath(args: {
  dataDir: string;
  path: string;
}): string {
  const target = path.resolve(args.path);
  const parent = path.dirname(target);
  const ownRoot = path.resolve(args.dataDir, WORKSPACES_DIR_NAME);
  const removable =
    parent !== target &&
    isSinglePathSegment(path.basename(target)) &&
    (parent === ownRoot || path.basename(parent) === CORE_WORKSPACES_DIR_NAME);
  if (!removable) {
    throw new PersonalWorkspacePathError(
      `Refusing to remove a path outside the personal workspace roots: ${args.path}`,
    );
  }
  return target;
}
