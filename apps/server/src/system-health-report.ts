import {
  Dirent,
  existsSync,
  lstatSync,
  readdirSync,
  statfsSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { expandHomeDirectory, resolveBbRoot } from "@bb/core/storage-paths";
import { type Project, type Thread } from "@bb/core";
import type {
  SystemHealthEnvironmentAgentProvider,
  SystemHealthEnvironmentAgentSession,
  SystemHealthDiskSummary,
  SystemHealthReport,
  SystemHealthStorageBucket,
  SystemHealthStorageBucketKey,
  SystemHealthThreadCounts,
} from "@bb/core";
import type {
  EnvironmentAgentSessionRecord,
  EnvironmentAgentSessionRepository,
  ProjectRepository,
  ThreadRepository,
} from "@bb/db";
import {
  resolveDefaultManagedWorktreeRoot,
  resolveManagedWorktreeRootForProject,
} from "./managed-storage-paths.js";
import { assessEnvironmentAgentSessionCompatibility } from "./environment-agent-session-compatibility.js";

export interface CreateSystemHealthReporterArgs {
  projectRepo: ProjectRepository;
  threadRepo: ThreadRepository;
  environmentAgentSessionRepo: EnvironmentAgentSessionRepository;
  getRunningCount: () => number;
  startTime: number;
  dbPath: string;
  daemonLogFilePath: string;
  runtimeEnv: NodeJS.ProcessEnv;
}

const STORAGE_BUCKET_LABELS: Record<SystemHealthStorageBucketKey, string> = {
  database: "Database",
  database_wal: "Database WAL",
  database_shm: "Database SHM",
  daemon_logs: "Daemon Logs",
  environment_agent_logs: "Environment Agent Logs",
  worktrees: "Worktrees",
  attachments: "Attachments",
  backups: "Backups",
};

function uniquePaths(paths: readonly string[]): string[] {
  return [...new Set(paths.map((path) => resolve(path)))];
}

function scanPathBytes(path: string): number {
  try {
    const stat = lstatSync(path);
    if (stat.isDirectory()) {
      let totalBytes = 0;
      const entries: Dirent[] = readdirSync(path, { withFileTypes: true });
      for (const entry of entries) {
        totalBytes += scanPathBytes(join(path, entry.name));
      }
      return totalBytes;
    }
    return stat.size;
  } catch {
    return 0;
  }
}

function listRotatingLogArtifacts(filePath: string): string[] {
  const directoryPath = dirname(filePath);
  const fileName = basename(filePath);
  const archivePattern = new RegExp(
    `^${fileName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:\\.\\d+)?$`,
  );

  try {
    return readdirSync(directoryPath)
      .filter((entry) => archivePattern.test(entry))
      .sort()
      .map((entry) => join(directoryPath, entry));
  } catch {
    return [filePath];
  }
}

function buildStorageBucket(
  key: SystemHealthStorageBucketKey,
  rawPaths: readonly string[],
): SystemHealthStorageBucket {
  const paths = uniquePaths(rawPaths);
  return {
    key,
    label: STORAGE_BUCKET_LABELS[key],
    bytes: paths.reduce((total, path) => total + scanPathBytes(path), 0),
    paths,
  };
}

function resolveDiskSummary(path: string): SystemHealthDiskSummary | undefined {
  try {
    const stats = statfsSync(path);
    const availableBytes = Number(stats.bavail) * Number(stats.bsize);
    const totalBytes = Number(stats.blocks) * Number(stats.bsize);
    const usedBytes = Math.max(0, totalBytes - (Number(stats.bfree) * Number(stats.bsize)));
    if (
      !Number.isFinite(availableBytes) ||
      !Number.isFinite(totalBytes) ||
      !Number.isFinite(usedBytes)
    ) {
      return undefined;
    }
    return {
      path,
      availableBytes,
      totalBytes,
      usedBytes,
    };
  } catch {
    return undefined;
  }
}

function buildThreadCounts(threads: readonly Thread[]): SystemHealthThreadCounts {
  const statusCounts: Record<Thread["status"], number> = {
    created: 0,
    provisioning: 0,
    provisioned: 0,
    provisioning_failed: 0,
    error: 0,
    active: 0,
    idle: 0,
  };
  let archived = 0;

  for (const thread of threads) {
    statusCounts[thread.status] += 1;
    if (thread.archivedAt !== undefined) {
      archived += 1;
    }
  }

  return {
    total: threads.length,
    archived,
    created: statusCounts.created,
    provisioning: statusCounts.provisioning,
    provisioned: statusCounts.provisioned,
    provisioningFailed: statusCounts.provisioning_failed,
    error: statusCounts.error,
    active: statusCounts.active,
    idle: statusCounts.idle,
  };
}

function isProviderMetadataArray(
  value: unknown,
): value is SystemHealthEnvironmentAgentProvider[] {
  return (
    Array.isArray(value) &&
    value.every(
      (item) =>
        typeof item === "object" &&
        item !== null &&
        typeof item.providerId === "string" &&
        typeof item.adapterVersion === "string" &&
        (item.runtimeVersion === undefined || typeof item.runtimeVersion === "string"),
    )
  );
}

function toEnvironmentAgentSessionSummary(
  session: EnvironmentAgentSessionRecord,
): SystemHealthEnvironmentAgentSession {
  const assessment = assessEnvironmentAgentSessionCompatibility(session);
  return {
    sessionId: session.id,
    threadId: session.threadId,
    ...(session.environmentId ? { environmentId: session.environmentId } : {}),
    agentId: session.agentId,
    agentInstanceId: session.agentInstanceId,
    protocolVersion: session.protocolVersion,
    ...(session.workerName && session.workerVersion
      ? {
          worker: {
            name: session.workerName,
            version: session.workerVersion,
            ...(session.workerBuildId ? { buildId: session.workerBuildId } : {}),
          },
        }
      : {}),
    ...(isProviderMetadataArray(session.providerMetadata)
      ? { providers: session.providerMetadata }
      : {}),
    selectedCapabilities: assessment.capabilities,
    compatibility: assessment.compatibility,
    ...(session.controlBaseUrl ? { controlBaseUrl: session.controlBaseUrl } : {}),
    leaseExpiresAt: session.leaseExpiresAt,
    ...(session.lastHeartbeatAt ? { lastHeartbeatAt: session.lastHeartbeatAt } : {}),
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  };
}

function resolveWorktreeBucketPaths(
  projects: readonly Pick<Project, "id" | "rootPath">[],
  runtimeEnv: NodeJS.ProcessEnv,
): string[] {
  const configuredRoot = runtimeEnv.BB_WORKTREE_ROOT?.trim() ?? "";
  const normalizedRoot = expandHomeDirectory(configuredRoot);

  if (normalizedRoot.length === 0 || normalizedRoot.startsWith("/")) {
    return [
      normalizedRoot.length === 0
        ? resolveDefaultManagedWorktreeRoot(runtimeEnv)
        : normalizedRoot,
    ];
  }

  if (projects.length === 0) {
    return [];
  }

  return projects.map((project) =>
    resolveManagedWorktreeRootForProject(project, runtimeEnv).worktreeRoot
  );
}

export function createSystemHealthReporter(args: CreateSystemHealthReporterArgs) {
  return (): SystemHealthReport => {
    const projects = args.projectRepo.list();
    const threads = args.threadRepo.list({ includeArchived: true });
    const activeEnvironmentAgentSessions = args.environmentAgentSessionRepo.listActive();
    const bbRoot = resolveBbRoot(args.runtimeEnv);
    const buckets = [
      buildStorageBucket("database", [args.dbPath]),
      buildStorageBucket("database_wal", [`${args.dbPath}-wal`]),
      buildStorageBucket("database_shm", [`${args.dbPath}-shm`]),
      buildStorageBucket("daemon_logs", listRotatingLogArtifacts(args.daemonLogFilePath)),
      buildStorageBucket("environment_agent_logs", [join(bbRoot, "environment-agent-logs")]),
      buildStorageBucket("worktrees", resolveWorktreeBucketPaths(projects, args.runtimeEnv)),
      buildStorageBucket("attachments", [join(bbRoot, "attachments")]),
      buildStorageBucket("backups", [join(bbRoot, "backups")]),
    ];

    const totalBytes = buckets.reduce((total, bucket) => total + bucket.bytes, 0);
    const diskPath = existsSync(bbRoot) ? bbRoot : dirname(args.dbPath);

    return {
      generatedAt: Date.now(),
      uptime: Math.floor((Date.now() - args.startTime) / 1000),
      projectCount: projects.length,
      runningThreads: args.getRunningCount(),
      threadCounts: buildThreadCounts(threads),
      environmentAgent: {
        activeSessionCount: activeEnvironmentAgentSessions.length,
        activeSessions: activeEnvironmentAgentSessions.map(
          toEnvironmentAgentSessionSummary,
        ),
      },
      storage: {
        totalBytes,
        disk: resolveDiskSummary(diskPath),
        buckets,
      },
    };
  };
}
