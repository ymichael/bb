import path from "node:path";
import {
  getAbsoluteGitDir,
  getGitCommonDir,
  type GitProcessOptions,
} from "./git.js";

function isSamePathOrNestedUnder(
  childPath: string,
  parentPath: string,
): boolean {
  const relativePath = path.relative(parentPath, childPath);
  return (
    relativePath === "" ||
    (relativePath.length > 0 &&
      !relativePath.startsWith("..") &&
      !path.isAbsolute(relativePath))
  );
}

function dedupeResolvedPaths(paths: readonly string[]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const value of paths) {
    const resolved = path.resolve(value);
    if (seen.has(resolved)) {
      continue;
    }
    seen.add(resolved);
    result.push(resolved);
  }
  return result;
}

function buildCommonGitWriteRoots(commonGitDir: string): string[] {
  return [
    path.join(commonGitDir, "objects"),
    path.join(commonGitDir, "refs"),
    path.join(commonGitDir, "logs"),
  ];
}

export async function resolveAdditionalWorkspaceWriteRoots(
  workspacePath: string,
  options: GitProcessOptions = {},
): Promise<string[]> {
  const resolvedWorkspacePath = path.resolve(workspacePath);
  const [gitDir, commonGitDir] = await Promise.all([
    getAbsoluteGitDir(resolvedWorkspacePath, options),
    getGitCommonDir(resolvedWorkspacePath, options),
  ]);
  const candidateRoots = dedupeResolvedPaths([
    gitDir,
    ...buildCommonGitWriteRoots(commonGitDir),
  ]);

  return candidateRoots.filter(
    (candidateRoot) =>
      !isSamePathOrNestedUnder(candidateRoot, resolvedWorkspacePath),
  );
}
