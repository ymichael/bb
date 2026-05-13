import type { Environment } from "@bb/domain";

interface ResolveThreadWorkspaceOpenPathArgs {
  canOpenWorkspace: boolean;
  environment: Environment | null | undefined;
  hasWorkspaceOpenTargets: boolean;
  threadEnvironmentIsLocal: boolean;
}

export interface ResolveThreadLocalWorkspaceRootPathArgs {
  environment: Environment | null | undefined;
  threadEnvironmentIsLocal: boolean;
}

export function resolveThreadLocalWorkspaceRootPath(
  args: ResolveThreadLocalWorkspaceRootPathArgs,
): string | null {
  if (!args.threadEnvironmentIsLocal) {
    return null;
  }

  return args.environment?.path ?? null;
}

export function resolveThreadWorkspaceOpenPath(
  args: ResolveThreadWorkspaceOpenPathArgs,
): string | null {
  if (!args.canOpenWorkspace || !args.hasWorkspaceOpenTargets) {
    return null;
  }

  return resolveThreadLocalWorkspaceRootPath({
    environment: args.environment,
    threadEnvironmentIsLocal: args.threadEnvironmentIsLocal,
  });
}
