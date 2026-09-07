import {
  type Environment,
  type LocalPathProjectSource,
  PERSONAL_PROJECT_ID,
} from "@bb/domain";
import type { EnvironmentArgs } from "@bb/server-contract";
import { ApiError } from "../../errors.js";
import type { AppDeps } from "../../types.js";
import { requireEnvironment } from "../lib/entity-lookup.js";
import {
  assertUsableHostId,
  requireConnectedPrimaryHostId,
} from "../hosts/primary-host.js";
import { requireSourceForHost } from "./thread-create-helpers.js";

type ThreadRequestEnvironment = EnvironmentArgs;
type ThreadRequestEnvironmentDeps = Pick<AppDeps, "config" | "db" | "hub">;
type HostThreadRequestEnvironment = Extract<
  ThreadRequestEnvironment,
  { type: "host" }
>;
type WorkspaceBackedHostWorkspace = Exclude<
  HostThreadRequestEnvironment["workspace"],
  { type: "personal" }
>;
type ReuseThreadRequestEnvironment = Extract<
  ThreadRequestEnvironment,
  { type: "reuse" }
>;
interface ResolveStableThreadRequestEnvironmentArgs {
  allowUnmanagedPersonalProjectReuseEnvironmentId?: string;
  environment: ThreadRequestEnvironment;
  projectId: string;
}

interface ResolvedHostThreadRequestEnvironment {
  hostId: string;
  localSource: LocalPathProjectSource | null;
  type: "host";
  unmanagedPath: string | null;
  workspace: WorkspaceBackedHostWorkspace;
}

interface ResolvedReuseThreadRequestEnvironment {
  environment: Environment;
  type: "reuse";
}

interface ResolvedPersonalThreadRequestEnvironment {
  hostId: string;
  type: "personal";
}

export type ResolvedStableThreadRequestEnvironment =
  | ResolvedHostThreadRequestEnvironment
  | ResolvedPersonalThreadRequestEnvironment
  | ResolvedReuseThreadRequestEnvironment;

function requireHostEnvironmentId(
  environment: HostThreadRequestEnvironment,
): string {
  if (environment.hostId !== undefined) {
    return environment.hostId;
  }
  throw new ApiError(
    400,
    "invalid_request",
    "hostId is required for workspace-backed thread creation",
  );
}

function assertPersonalWorkspaceProjectCompatibility(projectId: string): void {
  if (projectId !== PERSONAL_PROJECT_ID) {
    throw new ApiError(
      400,
      "invalid_request",
      "Personal workspaces are only supported for the personal project",
    );
  }
}

function assertReuseWorkspaceProjectCompatibility(
  projectId: string,
  environment: Environment,
  allowUnmanagedPersonalProjectReuseEnvironmentId: string | undefined,
): void {
  const projectIsPersonal = projectId === PERSONAL_PROJECT_ID;
  const environmentIsPersonal =
    environment.workspaceProvisionType === "personal";
  const environmentIsUnmanaged =
    environment.workspaceProvisionType === "unmanaged";
  if (
    projectIsPersonal &&
    !environmentIsPersonal &&
    !(
      environmentIsUnmanaged &&
      allowUnmanagedPersonalProjectReuseEnvironmentId === environment.id
    )
  ) {
    throw new ApiError(
      409,
      "invalid_request",
      "Personal project threads must reuse a personal workspace",
    );
  }
  if (!projectIsPersonal && environmentIsPersonal) {
    throw new ApiError(
      409,
      "invalid_request",
      "Standard project threads cannot reuse personal workspaces",
    );
  }
}

function resolveHostThreadRequestEnvironment(
  deps: ThreadRequestEnvironmentDeps,
  environment: HostThreadRequestEnvironment,
  projectId: string,
):
  | ResolvedHostThreadRequestEnvironment
  | ResolvedPersonalThreadRequestEnvironment {
  if (environment.workspace.type === "personal") {
    assertPersonalWorkspaceProjectCompatibility(projectId);
    const hostId = environment.hostId ?? requireConnectedPrimaryHostId(deps);
    assertUsableHostId(deps, { hostId });
    return {
      hostId,
      type: "personal",
    };
  }

  const hostId = requireHostEnvironmentId(environment);
  assertUsableHostId(deps, { hostId });

  if (
    environment.workspace.type === "unmanaged" &&
    environment.workspace.path !== null
  ) {
    return {
      hostId,
      localSource: null,
      type: "host",
      unmanagedPath: environment.workspace.path,
      workspace: environment.workspace,
    };
  }

  const localSource = requireSourceForHost(deps, projectId, hostId);

  return {
    hostId,
    localSource,
    type: "host",
    unmanagedPath:
      environment.workspace.type === "unmanaged" ? localSource.path : null,
    workspace: environment.workspace,
  };
}

function resolveReuseThreadRequestEnvironment(
  deps: ThreadRequestEnvironmentDeps,
  environment: ReuseThreadRequestEnvironment,
  projectId: string,
  allowUnmanagedPersonalProjectReuseEnvironmentId: string | undefined,
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
  assertReuseWorkspaceProjectCompatibility(
    projectId,
    reusedEnvironment,
    allowUnmanagedPersonalProjectReuseEnvironmentId,
  );
  assertUsableHostId(deps, { hostId: reusedEnvironment.hostId });
  return {
    environment: reusedEnvironment,
    type: "reuse",
  };
}

export function resolveStableThreadRequestEnvironment(
  deps: ThreadRequestEnvironmentDeps,
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
        args.allowUnmanagedPersonalProjectReuseEnvironmentId,
      );
    default: {
      const exhaustiveCheck: never = args.environment;
      throw new Error(
        `Unsupported thread request environment: ${exhaustiveCheck}`,
      );
    }
  }
}
