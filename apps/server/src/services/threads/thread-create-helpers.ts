import {
  createThread,
  getProjectSourceByHost,
  getProject,
  getThread,
} from "@bb/db";
import type { HostDaemonCommand } from "@bb/host-daemon-contract";
import type { LocalPathProjectSource } from "@bb/domain";
import type { BaseBranchSpec } from "@bb/server-contract";
import type { AppDeps } from "../../types.js";
import { ApiError } from "../../errors.js";
import type { ThreadCreateServiceRequest } from "./thread-create-request.js";
import {
  deriveTitleFallback,
  sanitizeGeneratedBranchSlug,
} from "./title-generation.js";

/**
 * Convert a {@link BaseBranchSpec} to the wire shape expected by the daemon's
 * `environment.provision` command. `{ kind: "default" }` becomes `null`,
 * which the daemon resolves to the source's default branch.
 */
export function baseBranchSpecToWire(spec: BaseBranchSpec): string | null {
  return spec.kind === "named" ? spec.name : null;
}

type EnvironmentProvisionCommand = Extract<
  HostDaemonCommand,
  { type: "environment.provision" }
>;
type EnvironmentProvisionCommandInitiator =
  EnvironmentProvisionCommand["initiator"];

export interface ManagedBranchNameArgs {
  branchSlug?: string | null;
  threadId: string;
}

export function buildManagedBranchName(args: ManagedBranchNameArgs): string {
  const branchSlug = args.branchSlug
    ? sanitizeGeneratedBranchSlug(args.branchSlug)
    : null;
  return branchSlug
    ? `bb/${branchSlug}-${args.threadId}`
    : `bb/${args.threadId}`;
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

/**
 * Pre-provision checkout for unmanaged workspaces, fully resolved on the
 * server (the daemon receives an explicit branch name in both kinds).
 */
export type UnmanagedCheckoutCommand =
  | { kind: "existing"; name: string }
  | { kind: "new"; name: string };

export type EnvironmentProvisionCommandArgs =
  | {
      workspaceProvisionType: "unmanaged";
      environmentId: string;
      hostId: string;
      initiator: EnvironmentProvisionCommandInitiator;
      path: string;
      checkout?: UnmanagedCheckoutCommand;
    }
  | {
      workspaceProvisionType: "managed-worktree" | "managed-clone";
      environmentId: string;
      hostId: string;
      initiator: EnvironmentProvisionCommandInitiator;
      sourcePath: string;
      targetPath: string;
      branchName: string;
      baseBranch: BaseBranchSpec;
      setupTimeoutMs: number;
    };

export function buildEnvironmentProvisionCommand(
  args: EnvironmentProvisionCommandArgs,
): EnvironmentProvisionCommand {
  return args.workspaceProvisionType === "unmanaged"
    ? {
        type: "environment.provision" as const,
        environmentId: args.environmentId,
        initiator: args.initiator,
        workspaceProvisionType: args.workspaceProvisionType,
        path: args.path,
        ...(args.checkout ? { checkout: args.checkout } : {}),
      }
    : {
        type: "environment.provision" as const,
        environmentId: args.environmentId,
        initiator: args.initiator,
        workspaceProvisionType: args.workspaceProvisionType,
        sourcePath: args.sourcePath,
        targetPath: args.targetPath,
        branchName: args.branchName,
        baseBranch: baseBranchSpecToWire(args.baseBranch),
        setupTimeoutMs: args.setupTimeoutMs,
      };
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

export function getThreadSafe(deps: Pick<AppDeps, "db">, threadId: string) {
  const thread = getThread(deps.db, threadId);
  if (!thread) {
    throw new ApiError(500, "internal_error", "Thread was not created");
  }
  return thread;
}
