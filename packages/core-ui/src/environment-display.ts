import type { Environment } from "@bb/domain";

export interface EnvironmentDisplayInfo {
  label: string;
  id: string;
}

/**
 * Format an environment for display.
 *
 * @param isLocalHost — whether the environment's host is the local machine
 */
export function formatEnvironmentDisplay(
  environment: Environment,
  isLocalHost: boolean,
): EnvironmentDisplayInfo {
  const location = isLocalHost ? "Local" : "Remote";
  const label = environment.isWorktree
    ? `${location} (Worktree)`
    : location;

  return { label, id: environment.id };
}
