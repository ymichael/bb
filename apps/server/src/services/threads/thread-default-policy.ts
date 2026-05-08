import {
  getBuiltInAgentProviderInfo,
  isAgentProviderId,
} from "@bb/agent-providers";
import type {
  PermissionMode,
  ProjectExecutionDefaults,
  ReasoningLevel,
  ServiceTier,
  Thread,
  ThreadType,
} from "@bb/domain";
import type { EnvironmentArgs } from "@bb/server-contract";
import {
  isLiveManagerParentThread,
  type ManagerParentThread,
} from "./thread-parent.js";

export const DEFAULT_SERVICE_TIER: ServiceTier = "default";
export const DEFAULT_REASONING_LEVEL: ReasoningLevel = "medium";
const DEFAULT_PERMISSION_MODE: PermissionMode = "full";
const MANAGED_CHILD_PERMISSION_MODE: PermissionMode = "workspace-write";
const MANAGER_DEFAULT_PROVIDER_ID = "pi";
const MANAGER_DEFAULT_MODEL = "anthropic/claude-opus-4-7";

export interface ResolveCreateThreadExecutionDefaultsArgs {
  requestedProviderId?: string;
  storedDefaults: ProjectExecutionDefaults | null;
  threadType: ThreadType;
}

export interface CreateThreadExecutionDefaultsResolved {
  executionDefaults: ProjectExecutionDefaults | null;
  kind: "resolved";
  providerId: string;
}

export interface CreateThreadExecutionDefaultsProviderRequired {
  kind: "provider_required";
}

export type ResolvedCreateThreadExecutionDefaults =
  | CreateThreadExecutionDefaultsResolved
  | CreateThreadExecutionDefaultsProviderRequired;

export interface IsManagedChildThreadArgs {
  parentThread?: ManagerParentThread | null;
  thread: Pick<Thread, "parentThreadId" | "projectId">;
}

export interface ResolveThreadDefaultPermissionModeArgs {
  parentThread?: ManagerParentThread | null;
  thread: Pick<Thread, "parentThreadId" | "projectId" | "providerId">;
}

export interface ResolveThreadExecutionPermissionModeArgs {
  lastExecutionPermissionMode?: PermissionMode;
  parentThread?: ManagerParentThread | null;
  projectExecutionPermissionMode?: PermissionMode;
  requestedPermissionMode?: PermissionMode;
  thread: Pick<Thread, "parentThreadId" | "projectId" | "providerId">;
}

export interface ResolveCreateThreadEnvironmentArgs {
  parentThread?: ManagerParentThread | null;
  projectId: string;
  requestedEnvironment: EnvironmentArgs;
  threadType: ThreadType;
}

export interface ResolveSupportedPermissionModeArgs {
  preferredPermissionMode: PermissionMode;
  providerId?: string;
}

type ImplicitHostDefaultEnvironment = Extract<EnvironmentArgs, { type: "host" }> & {
  workspace: { path: null; type: "unmanaged" };
};

function isImplicitHostDefaultEnvironment(
  environment: EnvironmentArgs,
): environment is ImplicitHostDefaultEnvironment {
  return (
    environment.type === "host" &&
    environment.workspace.type === "unmanaged" &&
    environment.workspace.path === null
  );
}

function isManagedChildThread(args: IsManagedChildThreadArgs): boolean {
  if (args.thread.parentThreadId === null) {
    return false;
  }

  return isLiveManagerParentThread({
    parentThread: args.parentThread ?? null,
    projectId: args.thread.projectId,
  });
}

function resolveSupportedPermissionMode(
  args: ResolveSupportedPermissionModeArgs,
): PermissionMode {
  if (!args.providerId || !isAgentProviderId(args.providerId)) {
    return args.preferredPermissionMode;
  }

  const supportedPermissionModes =
    getBuiltInAgentProviderInfo(args.providerId).capabilities
      .supportedPermissionModes;
  if (supportedPermissionModes.includes(args.preferredPermissionMode)) {
    return args.preferredPermissionMode;
  }
  if (supportedPermissionModes.includes(DEFAULT_PERMISSION_MODE)) {
    return DEFAULT_PERMISSION_MODE;
  }
  return supportedPermissionModes[0] ?? DEFAULT_PERMISSION_MODE;
}

function buildManagerThreadExecutionDefaults(
  providerId: string,
): ProjectExecutionDefaults | null {
  if (providerId !== MANAGER_DEFAULT_PROVIDER_ID) {
    return null;
  }

  return {
    providerId,
    model: MANAGER_DEFAULT_MODEL,
    reasoningLevel: DEFAULT_REASONING_LEVEL,
    permissionMode: resolveSupportedPermissionMode({
      providerId,
      preferredPermissionMode: DEFAULT_PERMISSION_MODE,
    }),
    serviceTier: DEFAULT_SERVICE_TIER,
  };
}

export function resolveCreateThreadExecutionDefaults(
  args: ResolveCreateThreadExecutionDefaultsArgs,
): ResolvedCreateThreadExecutionDefaults {
  const providerId =
    args.requestedProviderId ??
    args.storedDefaults?.providerId ??
    (args.threadType === "manager" ? MANAGER_DEFAULT_PROVIDER_ID : undefined);
  if (!providerId) {
    return { kind: "provider_required" };
  }

  const storedDefaults =
    args.storedDefaults?.providerId === providerId ? args.storedDefaults : null;
  if (storedDefaults) {
    return {
      kind: "resolved",
      executionDefaults: storedDefaults,
      providerId,
    };
  }

  return {
    kind: "resolved",
    executionDefaults:
      args.threadType === "manager"
        ? buildManagerThreadExecutionDefaults(providerId)
        : null,
    providerId,
  };
}

export function resolveCreateThreadEnvironment(
  args: ResolveCreateThreadEnvironmentArgs,
): EnvironmentArgs {
  if (
    args.threadType === "standard" &&
    isLiveManagerParentThread({
      parentThread: args.parentThread ?? null,
      projectId: args.projectId,
    }) &&
    isImplicitHostDefaultEnvironment(args.requestedEnvironment)
  ) {
    return {
      type: "host",
      hostId: args.requestedEnvironment.hostId,
      workspace: { type: "managed-worktree", baseBranch: { kind: "default" } },
    };
  }

  return args.requestedEnvironment;
}

export function resolveThreadDefaultPermissionMode(
  args: ResolveThreadDefaultPermissionModeArgs,
): PermissionMode {
  if (isManagedChildThread(args)) {
    return resolveSupportedPermissionMode({
      providerId: args.thread.providerId,
      preferredPermissionMode: MANAGED_CHILD_PERMISSION_MODE,
    });
  }

  return resolveSupportedPermissionMode({
    providerId: args.thread.providerId,
    preferredPermissionMode: DEFAULT_PERMISSION_MODE,
  });
}

export function resolveThreadExecutionPermissionMode(
  args: ResolveThreadExecutionPermissionModeArgs,
): PermissionMode {
  if (args.requestedPermissionMode) {
    return args.requestedPermissionMode;
  }
  if (args.lastExecutionPermissionMode) {
    return args.lastExecutionPermissionMode;
  }

  const defaultPermissionMode = resolveThreadDefaultPermissionMode({
    parentThread: args.parentThread,
    thread: args.thread,
  });
  if (isManagedChildThread(args)) {
    return defaultPermissionMode;
  }

  return args.projectExecutionPermissionMode ?? defaultPermissionMode;
}
