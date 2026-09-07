import type {
  PermissionMode,
  ProjectExecutionDefaults,
  RecordedPermissionMode,
  ReasoningLevel,
  ServiceTier,
  Thread,
} from "@bb/domain";
import { PERSONAL_PROJECT_ID, clampPermissionModeToCeiling } from "@bb/domain";
import type { EnvironmentArgs } from "@bb/server-contract";
import { COMMAND_TIMEOUT_MS } from "../../constants.js";
import type { WorkSessionDeps } from "../../types.js";
import type { ProviderRegistryService } from "../providers/provider-registry.js";
import { ApiError } from "../../errors.js";
import { callHostRetryableOnlineRpc } from "../hosts/online-rpc.js";
import { requireConnectedPrimaryHostId } from "../hosts/primary-host.js";
import { resolveProjectWorkspaceTarget } from "../projects/project-workspace.js";
import { resolveDefaultWorktreeBaseBranch } from "../projects/worktree-base-branch.js";
import { isLiveParentThread, type ParentThread } from "./thread-parent.js";

export const DEFAULT_SERVICE_TIER: ServiceTier = "default";
export const DEFAULT_REASONING_LEVEL: ReasoningLevel = "medium";

const DEFAULT_PERMISSION_MODE: PermissionMode = "auto";

function requireDefaultProviderId(registry: ProviderRegistryService): string {
  const listed = registry.list();
  const preferred = registry.getUserDefaultProviderId();
  const providerId =
    (preferred !== null
      ? listed.find(
          (registration) =>
            registration.info.id === preferred && registration.info.available,
        )
      : undefined
    )?.info.id ??
    listed.find((registration) => registration.info.available)?.info.id;
  if (providerId === undefined) {
    throw new ApiError(
      409,
      "no_provider_available",
      "No agent provider is enabled. Enable an agent provider plugin in Settings → Plugins to start a thread.",
    );
  }
  return providerId;
}

interface ResolveCreateThreadExecutionDefaultsArgs {
  requestedProviderId?: string;
  storedDefaults: ProjectExecutionDefaults | null;
}

interface CreateThreadExecutionDefaultsResolved {
  executionDefaults: ProjectExecutionDefaults | null;
  providerId: string;
}

interface IsManagedChildThreadArgs {
  parentThread?: ParentThread | null;
  thread: Pick<Thread, "parentThreadId" | "projectId">;
}

interface ResolveThreadDefaultPermissionModeArgs {
  thread: Pick<Thread, "providerId">;
}

interface ResolveThreadExecutionPermissionModeArgs {
  lastExecutionPermissionMode?: RecordedPermissionMode;
  parentThread?: ParentThread | null;
  parentThreadExecutionPermissionMode?: RecordedPermissionMode;
  projectExecutionPermissionMode?: PermissionMode;
  requestedPermissionMode?: PermissionMode;
  thread: Pick<
    Thread,
    "originKind" | "parentThreadId" | "projectId" | "providerId"
  >;
}

interface ResolveCreateThreadEnvironmentArgs {
  parentThread?: ParentThread | null;
  projectId: string;
  requestedEnvironment: EnvironmentArgs;
}

interface ResolveSupportedPermissionModeArgs {
  preferredPermissionMode: PermissionMode;
  providerId: string;
}

type ImplicitHostDefaultEnvironment = Extract<
  EnvironmentArgs,
  { type: "host" }
> & {
  workspace: { path: null; type: "unmanaged" };
};

type PersonalHostDefaultEnvironment = Extract<
  EnvironmentArgs,
  { type: "host" }
> & {
  workspace: { type: "personal" };
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

function isPersonalHostDefaultEnvironment(
  environment: EnvironmentArgs,
): environment is PersonalHostDefaultEnvironment {
  return (
    environment.type === "host" && environment.workspace.type === "personal"
  );
}

function requireHostEnvironmentId(
  environment: Extract<EnvironmentArgs, { type: "host" }>,
): string {
  if (environment.hostId !== undefined) {
    return environment.hostId;
  }
  throw new Error("Host environment is missing hostId");
}

function isManagedChildThread(args: IsManagedChildThreadArgs): boolean {
  if (args.thread.parentThreadId === null) {
    return false;
  }

  return isLiveParentThread({ parentThread: args.parentThread ?? null });
}

function resolveSupportedPermissionMode(
  registry: ProviderRegistryService,
  args: ResolveSupportedPermissionModeArgs,
): PermissionMode {
  const permissionModes = registry.getSupportedPermissionModes(args.providerId);
  if (!permissionModes) {
    return args.preferredPermissionMode;
  }

  if (permissionModes.includes(args.preferredPermissionMode)) {
    return args.preferredPermissionMode;
  }
  if (permissionModes.includes(DEFAULT_PERMISSION_MODE)) {
    return DEFAULT_PERMISSION_MODE;
  }
  if (permissionModes.includes("full")) {
    return "full";
  }
  return permissionModes[0] ?? DEFAULT_PERMISSION_MODE;
}

export function resolveCreateThreadExecutionDefaults(
  registry: ProviderRegistryService,
  args: ResolveCreateThreadExecutionDefaultsArgs,
): CreateThreadExecutionDefaultsResolved {
  const providerId =
    args.requestedProviderId ??
    args.storedDefaults?.providerId ??
    requireDefaultProviderId(registry);
  const registration = registry.get(providerId);
  if (registration !== null && !registration.info.available) {
    throw new ApiError(
      409,
      "provider_unavailable",
      `${registration.info.displayName} is unavailable because its provider plugin failed to load.`,
    );
  }

  const storedDefaults =
    args.storedDefaults?.providerId === providerId ? args.storedDefaults : null;
  return { executionDefaults: storedDefaults, providerId };
}

export function buildProviderThreadExecutionDefaults(
  registry: ProviderRegistryService,
  args: {
    model: string;
    providerId: string;
  },
): ProjectExecutionDefaults {
  return {
    providerId: args.providerId,
    model: args.model,
    reasoningLevel: DEFAULT_REASONING_LEVEL,
    permissionMode: resolveSupportedPermissionMode(registry, {
      providerId: args.providerId,
      preferredPermissionMode: DEFAULT_PERMISSION_MODE,
    }),
    serviceTier: DEFAULT_SERVICE_TIER,
  };
}

export async function resolveProjectDefaultThreadEnvironment(
  deps: WorkSessionDeps,
  args: { projectId: string },
): Promise<EnvironmentArgs> {
  if (args.projectId === PERSONAL_PROJECT_ID) {
    return { type: "host", workspace: { type: "personal" } };
  }

  const hostId = requireConnectedPrimaryHostId(deps);
  const source = resolveProjectWorkspaceTarget(deps, {
    hostId,
    projectId: args.projectId,
  });
  const checkout = await callHostRetryableOnlineRpc(deps, {
    hostId,
    timeoutMs: COMMAND_TIMEOUT_MS,
    command: {
      type: "host.inspect_git_source",
      path: source.path,
      remoteRefresh: "background",
    },
  });
  const baseBranch = resolveDefaultWorktreeBaseBranch(checkout);
  if (baseBranch === null) {
    return {
      type: "host",
      hostId,
      workspace: { type: "unmanaged", path: null },
    };
  }

  return {
    type: "host",
    hostId,
    workspace: {
      type: "managed-worktree",
      baseBranch: { kind: "named", name: baseBranch },
    },
  };
}

export function resolveCreateThreadEnvironment(
  args: ResolveCreateThreadEnvironmentArgs,
): EnvironmentArgs {
  const parentThread = args.parentThread ?? null;
  const hasLiveParent = isLiveParentThread({ parentThread });
  if (
    args.projectId === PERSONAL_PROJECT_ID &&
    hasLiveParent &&
    parentThread?.projectId === args.projectId &&
    isPersonalHostDefaultEnvironment(args.requestedEnvironment)
  ) {
    if (!args.parentThread?.environmentId) {
      throw new Error("Personal parent thread is missing an environment");
    }
    return {
      type: "reuse",
      environmentId: args.parentThread.environmentId,
    };
  }

  if (
    hasLiveParent &&
    isImplicitHostDefaultEnvironment(args.requestedEnvironment)
  ) {
    return {
      type: "host",
      hostId: requireHostEnvironmentId(args.requestedEnvironment),
      workspace: { type: "managed-worktree", baseBranch: { kind: "default" } },
    };
  }

  return args.requestedEnvironment;
}

export function resolveThreadDefaultPermissionMode(
  registry: ProviderRegistryService,
  args: ResolveThreadDefaultPermissionModeArgs,
): PermissionMode {
  return resolveSupportedPermissionMode(registry, {
    providerId: args.thread.providerId,
    preferredPermissionMode: DEFAULT_PERMISSION_MODE,
  });
}

export function resolveThreadExecutionPermissionMode(
  registry: ProviderRegistryService,
  args: ResolveThreadExecutionPermissionModeArgs,
): PermissionMode {
  const permissionMode = resolvePreferredThreadExecutionPermissionMode(
    registry,
    args,
  );
  if (
    !isManagedChildThread(args) ||
    args.parentThreadExecutionPermissionMode === undefined
  ) {
    return permissionMode;
  }

  const ceiling = normalizeRecordedPermissionMode(
    args.parentThreadExecutionPermissionMode,
  );
  const supported = registry.getSupportedPermissionModes(
    args.thread.providerId,
  );
  return (
    clampPermissionModeToCeiling({
      ceiling,
      permissionMode,
      ...(supported ? { permissionModes: supported } : {}),
    }) ?? ceiling
  );
}

function resolvePreferredThreadExecutionPermissionMode(
  registry: ProviderRegistryService,
  args: ResolveThreadExecutionPermissionModeArgs,
): PermissionMode {
  if (args.requestedPermissionMode) {
    return args.requestedPermissionMode;
  }
  if (args.lastExecutionPermissionMode) {
    return normalizeRecordedPermissionMode(args.lastExecutionPermissionMode);
  }

  if (
    isManagedChildThread(args) &&
    args.parentThreadExecutionPermissionMode !== undefined
  ) {
    return resolveSupportedPermissionMode(registry, {
      providerId: args.thread.providerId,
      preferredPermissionMode: normalizeRecordedPermissionMode(
        args.parentThreadExecutionPermissionMode,
      ),
    });
  }

  const defaultPermissionMode = resolveThreadDefaultPermissionMode(registry, {
    thread: args.thread,
  });
  return args.projectExecutionPermissionMode ?? defaultPermissionMode;
}

function normalizeRecordedPermissionMode(
  permissionMode: RecordedPermissionMode,
): PermissionMode {
  switch (permissionMode) {
    case "accept-edits":
    case "auto":
    case "full":
      return permissionMode;
    case "workspace-write":
    case "readonly":
      return "accept-edits";
  }
}
