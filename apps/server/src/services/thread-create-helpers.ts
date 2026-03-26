import path from "node:path";
import {
  createThread,
  getDefaultProjectSource,
  getProject,
  getThread,
  queueCommand,
} from "@bb/db";
import type { ProjectSource } from "@bb/domain";
import type { CreateThreadRequest } from "@bb/server-contract";
import type { AppDeps } from "../types.js";
import { ApiError } from "../errors.js";
import { requireConnectedHostSession } from "./entity-lookup.js";
import { deriveTitleFallback } from "./title-generation.js";

export interface ResolvedProjectSource extends ProjectSource {
  path: string;
}

function slugify(value: string): string {
  const cleaned = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  return cleaned.length > 0 ? cleaned : "thread";
}

export function buildManagedBranchName(
  request: CreateThreadRequest,
  threadId: string,
): string {
  const seed = request.title ?? deriveTitleFallback(request.input) ?? threadId;
  return `bb/${slugify(seed)}-${threadId.slice(0, 8)}`;
}

export function buildManagedTargetPath(
  sourcePath: string,
  projectId: string,
  threadId: string,
): string {
  return path.join(path.dirname(sourcePath), ".bb-worktrees", projectId, threadId);
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

export function requireDefaultSource(
  deps: Pick<AppDeps, "db">,
  projectId: string,
): ResolvedProjectSource {
  const source = getDefaultProjectSource(deps.db, projectId);
  if (!source) {
    throw new ApiError(409, "invalid_request", "Project has no default source");
  }
  if (!source.path) {
    throw new ApiError(
      409,
      "unsupported_operation",
      "Project source path is not available",
    );
  }
  return {
    ...source,
    path: source.path,
  };
}

export function queueEnvironmentProvision(
  deps: Pick<AppDeps, "db" | "hub">,
  args: {
    branchName?: string;
    environmentId: string;
    hostId: string;
    path?: string;
    projectId: string;
    scriptName?: string;
    sourcePath?: string;
    targetPath?: string;
    timeoutMs?: number;
    workspaceProvisionType: "managed-clone" | "managed-worktree" | "unmanaged";
  },
): void {
  const session = requireConnectedHostSession(deps, args.hostId);
  const payload = {
    type: "environment.provision" as const,
    environmentId: args.environmentId,
    projectId: args.projectId,
    workspaceProvisionType: args.workspaceProvisionType,
    ...(args.path ? { path: args.path } : {}),
    ...(args.sourcePath ? { sourcePath: args.sourcePath } : {}),
    ...(args.targetPath ? { targetPath: args.targetPath } : {}),
    ...(args.branchName ? { branchName: args.branchName } : {}),
    ...(args.scriptName ? { scriptName: args.scriptName } : {}),
    ...(args.timeoutMs ? { timeoutMs: args.timeoutMs } : {}),
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
  request: CreateThreadRequest,
  environmentId: string | null,
) {
  return createThread(deps.db, deps.hub, {
    projectId: request.projectId,
    environmentId,
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
