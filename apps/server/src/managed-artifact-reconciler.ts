import { execFileSync } from "node:child_process";
import {
  Dirent,
  existsSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { join, resolve } from "node:path";
import {
  type EnvironmentDescriptor,
  type EnvironmentRecord,
  type Project,
  type Thread,
} from "@bb/core";
import type { ThreadEnvironmentAttachmentRecord } from "@bb/db";
import { resolveBbPath } from "@bb/core/storage-paths";
import {
  removeRotatingJsonLineFileArtifacts,
  resolveDefaultEnvironmentAgentLogFilePath,
} from "@bb/environment-daemon";
import {
  resolveManagedWorktreeRootForProject,
} from "./managed-storage-paths.js";

const DEFAULT_ARCHIVED_LOG_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_MANAGED_ARTIFACT_SWEEP_INTERVAL_MS = 60 * 60 * 1000;

export type ManagedArtifactThreadRecord = Pick<
  Thread,
  "id" | "projectId" | "environmentId" | "archivedAt"
>;

export type ManagedArtifactEnvironmentRecord = Pick<
  EnvironmentRecord,
  "id" | "projectId" | "descriptor" | "managed"
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
  environments?: readonly ManagedArtifactEnvironmentRecord[];
  environmentAttachments?: readonly Pick<
    ThreadEnvironmentAttachmentRecord,
    "threadId" | "environmentId"
  >[];
  projects: readonly Project[];
  runtimeEnv: NodeJS.ProcessEnv;
  now?: number;
  archivedLogRetentionMs?: number;
}

function environmentPathFromDescriptor(descriptor?: EnvironmentDescriptor): string | undefined {
  return descriptor ? resolve(descriptor.path) : undefined;
}

function isLegacyManagedEnvironmentReference(environmentId: string | undefined): boolean {
  switch (environmentId?.trim()) {
    case "worktree":
    case "docker":
      return true;
    default:
      return false;
  }
}

export function resolveArchivedEnvironmentAgentLogRetentionMs(
  env: NodeJS.ProcessEnv,
): number {
  const configured = parseNumberEnv(env.BB_ARCHIVED_LOG_RETENTION_HOURS);
  if (configured === undefined || configured < 0) {
    return DEFAULT_ARCHIVED_LOG_RETENTION_MS;
  }
  return configured * 60 * 60 * 1000;
}

export function resolveManagedArtifactSweepIntervalMs(
  env: NodeJS.ProcessEnv,
): number {
  const configured = parseNumberEnv(env.BB_MANAGED_ARTIFACT_SWEEP_INTERVAL_MS);
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

  const hasFirstClassManagedEnvironments =
    Array.isArray(args.environments) &&
    Array.isArray(args.environmentAttachments);

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
      !hasFirstClassManagedEnvironments &&
      thread.archivedAt === undefined &&
      // Legacy fallback for pre-attachment threads that persisted a runtime kind
      // string in thread.environmentId instead of a first-class environment id.
      isLegacyManagedEnvironmentReference(environmentId)
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
  const environmentAgentLogsRoot = resolveBbPath(args.runtimeEnv, "environment-agent-logs");
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
  const activeManagedWorkspacePathsByProjectId = new Map<string, Set<string>>();

  if (hasFirstClassManagedEnvironments) {
    const threadById = new Map(args.threads.map((thread) => [thread.id, thread]));
    const environmentById = new Map(
      args.environments!.map((environment) => [environment.id, environment]),
    );

    for (const attachment of args.environmentAttachments!) {
      const thread = threadById.get(attachment.threadId);
      if (!thread || thread.archivedAt !== undefined) continue;
      const environment = environmentById.get(attachment.environmentId);
      if (!environment?.managed) continue;
      const workspaceRoot = environmentPathFromDescriptor(environment.descriptor);
      if (!workspaceRoot) continue;

      const keepPaths = activeManagedWorkspacePathsByProjectId.get(environment.projectId);
      if (keepPaths) {
        keepPaths.add(workspaceRoot);
      } else {
        activeManagedWorkspacePathsByProjectId.set(environment.projectId, new Set([workspaceRoot]));
      }
    }
  }

  for (const project of args.projects) {
    const worktreeRoot = worktreeRootsByProjectId.get(project.id);
    if (!worktreeRoot || !existsSync(worktreeRoot)) continue;
    const keepThreadIds = activeThreadIdsByProjectId.get(project.id) ?? new Set<string>();
    const keepWorkspacePaths = activeManagedWorkspacePathsByProjectId.get(project.id) ?? new Set<string>();
    const entries = readdirSync(worktreeRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const workspacePath = resolve(join(worktreeRoot, entry.name));
      const shouldKeep = hasFirstClassManagedEnvironments
        ? keepWorkspacePaths.has(workspacePath)
        : keepThreadIds.has(entry.name);
      if (shouldKeep) continue;
      removeManagedWorktreePath(project.rootPath, workspacePath);
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
