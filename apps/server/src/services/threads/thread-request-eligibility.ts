import { getProjectSourceByHost, listProjectSources } from "@bb/db";
import {
  isGitHubRepoProjectSource,
  type Environment,
  type GitHubRepoProjectSource,
  type LocalPathProjectSource,
  type ProjectSource,
} from "@bb/domain";
import type { BaseBranchSpec, EnvironmentArgs } from "@bb/server-contract";
import { ApiError } from "../../errors.js";
import type { AppDeps } from "../../types.js";
import {
  requireEnvironment,
  requireNonDestroyedHostWithStatus,
} from "../lib/entity-lookup.js";

type ThreadRequestEnvironment = EnvironmentArgs;
type HostThreadRequestEnvironment = Extract<
  ThreadRequestEnvironment,
  { type: "host" }
>;
type ReuseThreadRequestEnvironment = Extract<
  ThreadRequestEnvironment,
  { type: "reuse" }
>;
type SandboxHostThreadRequestEnvironment = Extract<
  ThreadRequestEnvironment,
  { type: "sandbox-host" }
>;

export interface ResolveStableThreadRequestEnvironmentArgs {
  environment: ThreadRequestEnvironment;
  projectId: string;
}

export interface StableThreadRequestProjectData {
  environmentsById: ReadonlyMap<string, Environment>;
  existingHostIds: ReadonlySet<string>;
  projectId: string;
  projectSources: readonly ProjectSource[];
}

export interface ResolvedHostThreadRequestEnvironment {
  hostId: string;
  localSource: LocalPathProjectSource | null;
  type: "host";
  unmanagedPath: string | null;
  workspace: HostThreadRequestEnvironment["workspace"];
}

export interface ResolvedReuseThreadRequestEnvironment {
  environment: Environment;
  type: "reuse";
}

export interface ResolvedSandboxHostThreadRequestEnvironment {
  cloneSource: GitHubRepoProjectSource;
  baseBranch: BaseBranchSpec;
  sandboxType: SandboxHostThreadRequestEnvironment["sandboxType"];
  type: "sandbox-host";
}

export type ResolvedStableThreadRequestEnvironment =
  | ResolvedHostThreadRequestEnvironment
  | ResolvedReuseThreadRequestEnvironment
  | ResolvedSandboxHostThreadRequestEnvironment;

function compareSandboxCloneSourcePreference(
  left: GitHubRepoProjectSource,
  right: GitHubRepoProjectSource,
): number {
  if (left.isDefault !== right.isDefault) {
    return left.isDefault ? -1 : 1;
  }
  if (left.createdAt !== right.createdAt) {
    return left.createdAt - right.createdAt;
  }
  return left.id.localeCompare(right.id);
}

function selectSandboxCloneSource(
  projectSources: readonly ProjectSource[],
): GitHubRepoProjectSource | null {
  const cloneSources = projectSources
    .filter(isGitHubRepoProjectSource)
    .sort(compareSandboxCloneSourcePreference);

  return cloneSources[0] ?? null;
}

function resolveSandboxCloneSourceForProject(
  deps: Pick<AppDeps, "db">,
  args: { projectId: string },
): GitHubRepoProjectSource {
  const cloneSource = selectSandboxCloneSource(
    listProjectSources(deps.db, args.projectId),
  );
  if (!cloneSource) {
    throw new ApiError(
      409,
      "unsupported_operation",
      "Sandbox threads require a cloneable project source; local path sources are not supported yet",
    );
  }

  return cloneSource;
}

function requireExistingProjectHost(
  data: StableThreadRequestProjectData,
  hostId: string,
): void {
  if (!data.existingHostIds.has(hostId)) {
    throw new ApiError(404, "host_not_found", "Host not found");
  }
}

function resolveStableHostThreadRequestEnvironmentFromProjectData(
  data: StableThreadRequestProjectData,
  environment: HostThreadRequestEnvironment,
): ResolvedHostThreadRequestEnvironment {
  requireExistingProjectHost(data, environment.hostId);

  if (
    environment.workspace.type === "unmanaged" &&
    environment.workspace.path !== null
  ) {
    return {
      hostId: environment.hostId,
      localSource: null,
      type: "host",
      unmanagedPath: environment.workspace.path,
      workspace: environment.workspace,
    };
  }

  const localSource =
    data.projectSources.find(
      (source): source is LocalPathProjectSource =>
        source.type === "local_path" && source.hostId === environment.hostId,
    ) ?? null;
  if (!localSource) {
    throw new ApiError(
      409,
      "invalid_request",
      "No project source configured for this host",
    );
  }

  return {
    hostId: environment.hostId,
    localSource,
    type: "host",
    unmanagedPath:
      environment.workspace.type === "unmanaged" ? localSource.path : null,
    workspace: environment.workspace,
  };
}

function resolveStableReuseThreadRequestEnvironmentFromProjectData(
  data: StableThreadRequestProjectData,
  environment: ReuseThreadRequestEnvironment,
): ResolvedReuseThreadRequestEnvironment {
  const reusedEnvironment = data.environmentsById.get(
    environment.environmentId,
  );
  if (!reusedEnvironment) {
    throw new ApiError(404, "environment_not_found", "Environment not found");
  }
  if (reusedEnvironment.projectId !== data.projectId) {
    throw new ApiError(
      409,
      "invalid_request",
      "Environment belongs to a different project",
    );
  }

  return {
    environment: reusedEnvironment,
    type: "reuse",
  };
}

export function resolveStableThreadRequestEnvironmentFromProjectData(
  data: StableThreadRequestProjectData,
  environment: ThreadRequestEnvironment,
): ResolvedStableThreadRequestEnvironment {
  switch (environment.type) {
    case "host":
      return resolveStableHostThreadRequestEnvironmentFromProjectData(
        data,
        environment,
      );
    case "reuse":
      return resolveStableReuseThreadRequestEnvironmentFromProjectData(
        data,
        environment,
      );
    case "sandbox-host": {
      const cloneSource = selectSandboxCloneSource(data.projectSources);
      if (!cloneSource) {
        throw new ApiError(
          409,
          "unsupported_operation",
          "Sandbox threads require a cloneable project source; local path sources are not supported yet",
        );
      }

      return {
        cloneSource,
        baseBranch: environment.baseBranch,
        sandboxType: environment.sandboxType,
        type: "sandbox-host",
      };
    }
    default: {
      const exhaustiveCheck: never = environment;
      throw new Error(
        `Unsupported thread request environment: ${exhaustiveCheck}`,
      );
    }
  }
}

function resolveHostThreadRequestEnvironment(
  deps: Pick<AppDeps, "db">,
  environment: HostThreadRequestEnvironment,
  projectId: string,
): ResolvedHostThreadRequestEnvironment {
  requireNonDestroyedHostWithStatus(deps.db, environment.hostId);

  if (
    environment.workspace.type === "unmanaged" &&
    environment.workspace.path !== null
  ) {
    return {
      hostId: environment.hostId,
      localSource: null,
      type: "host",
      unmanagedPath: environment.workspace.path,
      workspace: environment.workspace,
    };
  }

  const localSource = getProjectSourceByHost(
    deps.db,
    projectId,
    environment.hostId,
  );
  if (!localSource || localSource.type !== "local_path") {
    throw new ApiError(
      409,
      "invalid_request",
      "No project source configured for this host",
    );
  }

  return {
    hostId: environment.hostId,
    localSource,
    type: "host",
    unmanagedPath:
      environment.workspace.type === "unmanaged" ? localSource.path : null,
    workspace: environment.workspace,
  };
}

function resolveReuseThreadRequestEnvironment(
  deps: Pick<AppDeps, "db">,
  environment: ReuseThreadRequestEnvironment,
  projectId: string,
): ResolvedReuseThreadRequestEnvironment {
  const reusedEnvironment = requireEnvironment(
    deps.db,
    environment.environmentId,
  );
  if (reusedEnvironment.projectId !== projectId) {
    throw new ApiError(
      409,
      "invalid_request",
      "Environment belongs to a different project",
    );
  }
  return {
    environment: reusedEnvironment,
    type: "reuse",
  };
}

export function resolveStableThreadRequestEnvironment(
  deps: Pick<AppDeps, "db">,
  args: ResolveStableThreadRequestEnvironmentArgs,
): ResolvedStableThreadRequestEnvironment {
  switch (args.environment.type) {
    case "host":
      return resolveHostThreadRequestEnvironment(
        deps,
        args.environment,
        args.projectId,
      );
    case "reuse":
      return resolveReuseThreadRequestEnvironment(
        deps,
        args.environment,
        args.projectId,
      );
    case "sandbox-host":
      return {
        cloneSource: resolveSandboxCloneSourceForProject(deps, {
          projectId: args.projectId,
        }),
        baseBranch: args.environment.baseBranch,
        sandboxType: args.environment.sandboxType,
        type: "sandbox-host",
      };
    default: {
      const exhaustiveCheck: never = args.environment;
      throw new Error(
        `Unsupported thread request environment: ${exhaustiveCheck}`,
      );
    }
  }
}
