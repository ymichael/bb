import type { Environment } from "@bb/domain";

interface ResolveThreadWorkspaceOpenPathArgs {
  canOpenWorkspace: boolean;
  environment: Environment | null | undefined;
  hasWorkspaceOpenTargets: boolean;
  threadEnvironmentIsLocal: boolean;
}

export function resolveThreadWorkspaceOpenPath(
  args: ResolveThreadWorkspaceOpenPathArgs,
): string | null {
  if (!args.canOpenWorkspace || !args.hasWorkspaceOpenTargets) {
    return null;
  }

  if (!args.threadEnvironmentIsLocal) {
    return null;
  }

  if (args.environment?.status !== "ready") {
    return null;
  }

  return args.environment.path;
}

