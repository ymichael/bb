import { execFileSync } from "node:child_process";
import {
  Dirent,
  existsSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { join, resolve } from "node:path";
import {
  type Project,
  type Thread,
} from "@beanbag/agent-core";
import { resolveBeanbagPath } from "@beanbag/agent-core/storage-paths";
import {
  removeRotatingJsonLineFileArtifacts,
  resolveDefaultEnvironmentAgentLogFilePath,
} from "@beanbag/environment-agent";
import {
  resolveManagedWorktreeRootForProject,
} from "./managed-storage-paths.js";

const DEFAULT_ARCHIVED_LOG_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_MANAGED_ARTIFACT_SWEEP_INTERVAL_MS = 60 * 60 * 1000;

export type ManagedArtifactThreadRecord = Pick<
  Thread,
  "id" | "projectId" | "environmentId" | "archivedAt"
>;

function resolveManagedWorkspaceRoot(
  thread: Pick<ManagedArtifactThreadRecord, "id" | "projectId">,
  project: Pick<Project, "id" | "rootPath">,
  runtimeEnv: NodeJS.ProcessEnv,
): string {
  const { worktreeRoot } = resolveManagedWorktreeRootForProject(project, runtimeEnv);
  return resolve(worktreeRoot, thread.id);
}

function parseNumberEnv(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value.trim(), 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function baseLogPath(filePath: string): string {
  return filePath.replace(/\.\d+$/, "");
}

function removeEmptyDirectories(rootPath: string): void {
  if (!existsSync(rootPath)) return;

  const removeIfEmpty = (path: string): boolean => {
    let entries: Dirent[];
    try {
      entries = readdirSync(path, { withFileTypes: true });
    } catch {
      return false;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      removeIfEmpty(join(path, entry.name));
    }

    try {
      const remaining = readdirSync(path);
      if (remaining.length === 0) {
        rmSync(path, { recursive: true, force: true });
        return true;
      }
    } catch {
      return false;
    }
    return false;
  };

  removeIfEmpty(rootPath);
}

function removeDirectoryIfEmpty(path: string): void {
  if (!existsSync(path)) return;
  try {
    if (readdirSync(path).length === 0) {
      rmSync(path, { recursive: true, force: true });
    }
  } catch {
    // Best-effort cleanup only.
  }
}

function removeManagedWorktreePath(projectRoot: string, workspaceRoot: string): void {
  try {
    if (existsSync(resolve(projectRoot, ".git"))) {
      execFileSync("git", ["worktree", "remove", "--force", workspaceRoot], {
        cwd: projectRoot,
        stdio: "ignore",
      });
    }
  } catch {
    // Fall through to recursive deletion when git metadata cleanup fails.
  }

  rmSync(workspaceRoot, { recursive: true, force: true });
}

function scanFilesRecursively(rootPath: string): string[] {
  if (!existsSync(rootPath)) return [];
  const paths: string[] = [];

  const walk = (currentPath: string) => {
    let entries: Dirent[];
    try {
      entries = readdirSync(currentPath, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = join(currentPath, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile()) {
        paths.push(fullPath);
      }
    }
  };

  walk(rootPath);
  return paths;
}

export interface ManagedArtifactReconcilerResult {
  removedLogArtifacts: number;
  removedWorkspaceDirectories: number;
}

export interface ReconcileManagedArtifactStorageArgs {
  threads: readonly ManagedArtifactThreadRecord[];
  projects: readonly Project[];
  runtimeEnv: NodeJS.ProcessEnv;
  now?: number;
  archivedLogRetentionMs?: number;
}

export function resolveArchivedEnvironmentAgentLogRetentionMs(
  env: NodeJS.ProcessEnv,
): number {
  const configured = parseNumberEnv(env.BEANBAG_ARCHIVED_LOG_RETENTION_HOURS);
  if (configured === undefined || configured < 0) {
    return DEFAULT_ARCHIVED_LOG_RETENTION_MS;
  }
  return configured * 60 * 60 * 1000;
}

export function resolveManagedArtifactSweepIntervalMs(
  env: NodeJS.ProcessEnv,
): number {
  const configured = parseNumberEnv(env.BEANBAG_MANAGED_ARTIFACT_SWEEP_INTERVAL_MS);
  if (configured === undefined || configured < 0) {
    return DEFAULT_MANAGED_ARTIFACT_SWEEP_INTERVAL_MS;
  }
  return configured;
}

export function reconcileManagedArtifactStorage(
  args: ReconcileManagedArtifactStorageArgs,
): ManagedArtifactReconcilerResult {
  const now = args.now ?? Date.now();
  const archivedLogRetentionMs =
    args.archivedLogRetentionMs ?? resolveArchivedEnvironmentAgentLogRetentionMs(args.runtimeEnv);
  const archivedLogCutoff = now - archivedLogRetentionMs;
  const projectById = new Map(args.projects.map((project) => [project.id, project]));

  const keptLogPaths = new Set<string>();
  const activeThreadIdsByProjectId = new Map<string, Set<string>>();
  const worktreeRootsByProjectId = new Map<string, string>();
  const globalWorktreeRoots = new Set<string>();

  for (const project of args.projects) {
    const { worktreeRoot, globalRoot } = resolveManagedWorktreeRootForProject(project, args.runtimeEnv);
    worktreeRootsByProjectId.set(project.id, worktreeRoot);
    if (globalRoot) {
      globalWorktreeRoots.add(globalRoot);
    }
  }

  for (const thread of args.threads) {
    const environmentId = thread.environmentId?.trim();
    if (environmentId) {
      const shouldKeepLogs =
        thread.archivedAt === undefined ||
        (typeof thread.archivedAt === "number" && thread.archivedAt >= archivedLogCutoff);
      if (shouldKeepLogs) {
        keptLogPaths.add(resolveDefaultEnvironmentAgentLogFilePath({
          projectId: thread.projectId,
          threadId: thread.id,
          environmentId,
          runtimeEnv: args.runtimeEnv,
        }));
      }
    }

    if (
      thread.archivedAt === undefined &&
      (environmentId === "worktree" || environmentId === "docker")
    ) {
      const activeThreadIds = activeThreadIdsByProjectId.get(thread.projectId);
      if (activeThreadIds) {
        activeThreadIds.add(thread.id);
      } else {
        activeThreadIdsByProjectId.set(thread.projectId, new Set([thread.id]));
      }
    }
  }

  let removedLogArtifacts = 0;
  const seenLogBasePaths = new Set<string>();
  const environmentAgentLogsRoot = resolveBeanbagPath(args.runtimeEnv, "environment-agent-logs");
  for (const filePath of scanFilesRecursively(environmentAgentLogsRoot)) {
    const basePath = baseLogPath(filePath);
    if (seenLogBasePaths.has(basePath)) continue;
    seenLogBasePaths.add(basePath);
    if (keptLogPaths.has(basePath)) continue;
    removeRotatingJsonLineFileArtifacts(basePath);
    removedLogArtifacts += 1;
  }
  removeEmptyDirectories(environmentAgentLogsRoot);

  let removedWorkspaceDirectories = 0;
  for (const project of args.projects) {
    const worktreeRoot = worktreeRootsByProjectId.get(project.id);
    if (!worktreeRoot || !existsSync(worktreeRoot)) continue;
    const keepThreadIds = activeThreadIdsByProjectId.get(project.id) ?? new Set<string>();
    const entries = readdirSync(worktreeRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (keepThreadIds.has(entry.name)) continue;
      removeManagedWorktreePath(project.rootPath, join(worktreeRoot, entry.name));
      removedWorkspaceDirectories += 1;
    }
    removeDirectoryIfEmpty(worktreeRoot);
  }

  for (const globalRoot of globalWorktreeRoots) {
    if (!existsSync(globalRoot)) continue;
    const knownProjectIds = new Set(projectById.keys());
    const projectEntries = readdirSync(globalRoot, { withFileTypes: true });
    for (const entry of projectEntries) {
      if (!entry.isDirectory()) continue;
      if (knownProjectIds.has(entry.name)) continue;
      rmSync(join(globalRoot, entry.name), { recursive: true, force: true });
      removedWorkspaceDirectories += 1;
    }
    removeDirectoryIfEmpty(globalRoot);
  }

  return {
    removedLogArtifacts,
    removedWorkspaceDirectories,
  };
}
