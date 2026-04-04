import path from "node:path";
import {
  createThread,
  getDefaultProjectSource,
  getProjectSourceByHost,
  getProject,
  getThread,
  queueCommand,
} from "@bb/db";
import type {
  GitHubRepoProjectSource,
  LocalPathProjectSource,
} from "@bb/domain";
import type { AppDeps } from "../types.js";
import { ApiError } from "../errors.js";
import { requireConnectedHostSession } from "./entity-lookup.js";
import type { ThreadCreateServiceRequest } from "./thread-create-request.js";
import { deriveTitleFallback } from "./title-generation.js";

const REMOTE_WORKSPACE_ROOT = "/tmp/bb-managed-workspaces";

function slugify(value: string): string {
  const cleaned = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  return cleaned.length > 0 ? cleaned : "thread";
}

export function buildManagedBranchNameFromSeed(
  seed: string,
  threadId: string,
): string {
  return `bb/${slugify(seed)}-${threadId.slice(0, 8)}`;
}

export function buildManagedBranchName(
  request: ThreadCreateServiceRequest,
  threadId: string,
): string {
  const seed = request.title
    ?? deriveTitleFallback(request.input)
    ?? threadId;
  return buildManagedBranchNameFromSeed(seed, threadId);
}

function isRemoteSourcePath(sourcePath: string): boolean {
  if (sourcePath.startsWith("git@")) {
    return true;
  }

  try {
    const protocol = new URL(sourcePath).protocol;
    return protocol === "http:" || protocol === "https:" || protocol === "ssh:";
  } catch {
    return false;
  }
}

export function buildManagedTargetPath(
  sourcePath: string,
  projectId: string,
  threadId: string,
): string {
  if (isRemoteSourcePath(sourcePath)) {
    return path.join(REMOTE_WORKSPACE_ROOT, projectId, threadId);
  }

  return path.join(path.dirname(sourcePath), ".bb-worktrees", projectId, threadId);
}

export function buildSandboxTargetPath(
  projectId: string,
  threadId: string,
): string {
  return path.posix.join("/tmp", ".bb-worktrees", projectId, threadId);
}

export function requireProjectExists(
  deps: Pick<AppDeps, "db">,
  projectId: string,
) {
  const project = getProject(deps.db, projectId);
  if (!project) {
    throw new ApiError(404, "project_not_found", "Project not found");
  }
  return project;
}

export const SETUP_SCRIPT_NAME = ".bb-env-setup.sh";
export const SETUP_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes

export function requireSourceForHost(
  deps: Pick<AppDeps, "db">,
  projectId: string,
  hostId: string,
): LocalPathProjectSource {
  const source = getProjectSourceByHost(deps.db, projectId, hostId);
  if (!source || source.type !== "local_path") {
    throw new ApiError(
      409,
      "invalid_request",
      "No project source configured for this host",
    );
  }
  return source;
}

export function requireSandboxCloneSource(
  deps: Pick<AppDeps, "db">,
  projectId: string,
): GitHubRepoProjectSource {
  const source = getDefaultProjectSource(deps.db, projectId);
  if (!source || source.type !== "github_repo") {
    throw new ApiError(
      409,
      "unsupported_operation",
      "Sandbox threads require a cloneable project source; local path sources are not supported yet",
    );
  }
  return source;
}

type QueueEnvironmentProvisionArgs =
  | {
      workspaceProvisionType: "unmanaged";
      environmentId: string;
      hostId: string;
      initiator: { threadId: string; eventSequence: number } | null;
      path?: string;
    }
  | {
      workspaceProvisionType: "managed-worktree" | "managed-clone";
      environmentId: string;
      hostId: string;
      initiator: { threadId: string; eventSequence: number } | null;
      sourcePath: string;
      targetPath: string;
      branchName: string;
      setupScript: string;
      setupTimeoutMs: number;
    };

export function queueEnvironmentProvision(
  deps: Pick<AppDeps, "db" | "hub">,
  args: QueueEnvironmentProvisionArgs,
): void {
  const session = requireConnectedHostSession(deps, args.hostId);
  const payload =
    args.workspaceProvisionType === "unmanaged"
      ? {
          type: "environment.provision" as const,
          environmentId: args.environmentId,
          initiator: args.initiator,
          workspaceProvisionType: args.workspaceProvisionType,
          ...(args.path != null ? { path: args.path } : {}),
        }
      : {
          type: "environment.provision" as const,
          environmentId: args.environmentId,
          initiator: args.initiator,
          workspaceProvisionType: args.workspaceProvisionType,
          sourcePath: args.sourcePath,
          targetPath: args.targetPath,
          branchName: args.branchName,
          setupScript: args.setupScript,
          setupTimeoutMs: args.setupTimeoutMs,
        };
  queueCommand(deps.db, deps.hub, {
    hostId: args.hostId,
    sessionId: session.id,
    type: "environment.provision",
    payload: JSON.stringify(payload),
  });
}

export function createThreadRecord(
  deps: Pick<AppDeps, "db" | "hub">,
  request: ThreadCreateServiceRequest,
  environmentId: string | null,
) {
  return createThread(deps.db, deps.hub, {
    projectId: request.projectId,
    environmentId,
    automationId: request.automationId,
    providerId: request.providerId,
    type: request.type,
    title: request.title ?? null,
    titleFallback: deriveTitleFallback(request.input),
    parentThreadId: request.parentThreadId ?? null,
    status: "created",
  });
}

export function getThreadSafe(
  deps: Pick<AppDeps, "db">,
  threadId: string,
) {
  const thread = getThread(deps.db, threadId);
  if (!thread) {
    throw new ApiError(500, "internal_error", "Thread was not created");
  }
  return thread;
}
