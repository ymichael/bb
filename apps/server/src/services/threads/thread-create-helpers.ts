import path from "node:path";
import {
  createThread,
  getProjectSourceByHost,
  getProject,
  getThread,
} from "@bb/db";
import type { HostDaemonCommand } from "@bb/host-daemon-contract";
import type {
  LocalPathProjectSource,
} from "@bb/domain";
import { DEFAULT_ENV_SETUP_SCRIPT_NAME } from "@bb/domain";
import type { AppDeps } from "../../types.js";
import { ApiError } from "../../errors.js";
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

export const SETUP_SCRIPT_NAME = DEFAULT_ENV_SETUP_SCRIPT_NAME;
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

export type EnvironmentProvisionCommandArgs =
  | {
      workspaceProvisionType: "unmanaged";
      environmentId: string;
      hostId: string;
      initiator: { threadId: string; eventSequence: number } | null;
      path: string;
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

export function buildEnvironmentProvisionCommand(
  args: EnvironmentProvisionCommandArgs,
): Extract<HostDaemonCommand, { type: "environment.provision" }> {
  return (
    args.workspaceProvisionType === "unmanaged"
      ? {
          type: "environment.provision" as const,
          environmentId: args.environmentId,
          initiator: args.initiator,
          workspaceProvisionType: args.workspaceProvisionType,
          path: args.path,
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
        }
  );
}

export function createThreadRecord(
  deps: Pick<AppDeps, "db" | "hub">,
  args: {
    environmentId: string | null;
    request: ThreadCreateServiceRequest;
    status?: "created" | "provisioning";
  },
) {
  return createThread(deps.db, deps.hub, {
    projectId: args.request.projectId,
    environmentId: args.environmentId,
    automationId: args.request.automationId,
    providerId: args.request.providerId,
    type: args.request.type,
    title: args.request.title ?? null,
    titleFallback: deriveTitleFallback(args.request.input),
    parentThreadId: args.request.parentThreadId ?? null,
    status: args.status ?? "created",
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
