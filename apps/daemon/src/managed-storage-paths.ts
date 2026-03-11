import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { Project, Thread } from "@beanbag/agent-core";

export const DEFAULT_WORKTREE_ROOT = "~/.beanbag/worktrees";

function sanitizeSegment(value: string | undefined): string {
  const normalized = (value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized.length > 0 ? normalized : "environment";
}

export function expandHomeDirectory(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
  return path;
}

export function resolveConfiguredWorktreeRoot(
  projectRoot: string,
  configuredRoot: string,
): { root: string; isGlobalRoot: boolean } {
  const normalizedRoot = expandHomeDirectory(configuredRoot.trim());
  if (normalizedRoot.length === 0) {
    return { root: expandHomeDirectory(DEFAULT_WORKTREE_ROOT), isGlobalRoot: true };
  }
  if (normalizedRoot.startsWith("/")) {
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
  const configuredRoot =
    runtimeEnv.BEANBAG_WORKTREE_ROOT?.trim() || DEFAULT_WORKTREE_ROOT;
  const { root, isGlobalRoot } = resolveConfiguredWorktreeRoot(project.rootPath, configuredRoot);
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

export function resolveManagedEnvironmentAgentStateFilePath(
  identity: Pick<Thread, "id" | "projectId" | "environmentId">,
): string | undefined {
  const environmentId = identity.environmentId?.trim();
  if (!environmentId) {
    return undefined;
  }

  return join(
    homedir(),
    ".beanbag",
    "environment-agents",
    sanitizeSegment(identity.projectId),
    `${sanitizeSegment(environmentId)}-${sanitizeSegment(identity.id)}.json`,
  );
}
