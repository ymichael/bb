import { isAbsolute, resolve } from "node:path";
import { expandHomeDirectory, resolveBeanbagPath } from "@beanbag/agent-core/storage-paths";
import {
  type Project,
} from "@beanbag/agent-core";

export function resolveDefaultManagedWorktreeRoot(
  runtimeEnv: NodeJS.ProcessEnv,
): string {
  return resolveBeanbagPath(runtimeEnv, "worktrees");
}

export function resolveConfiguredWorktreeRoot(
  projectRoot: string,
  configuredRoot: string,
  runtimeEnv: NodeJS.ProcessEnv = process.env,
): { root: string; isGlobalRoot: boolean } {
  const normalizedRoot = expandHomeDirectory(configuredRoot.trim());
  if (normalizedRoot.length === 0) {
    return { root: resolveDefaultManagedWorktreeRoot(runtimeEnv), isGlobalRoot: true };
  }
  if (isAbsolute(normalizedRoot)) {
    return { root: normalizedRoot, isGlobalRoot: true };
  }
  return {
    root: resolve(projectRoot, normalizedRoot),
    isGlobalRoot: false,
  };
}

export function resolveManagedWorktreeRootForProject(
  project: Pick<Project, "id" | "rootPath">,
  runtimeEnv: NodeJS.ProcessEnv,
): { worktreeRoot: string; globalRoot?: string } {
  const configuredRoot = runtimeEnv.BEANBAG_WORKTREE_ROOT?.trim() ?? "";
  const { root, isGlobalRoot } = resolveConfiguredWorktreeRoot(
    project.rootPath,
    configuredRoot,
    runtimeEnv,
  );
  if (isGlobalRoot) {
    return {
      worktreeRoot: resolve(root, project.id),
      globalRoot: root,
    };
  }
  return {
    worktreeRoot: root,
  };
}
