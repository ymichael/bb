import type { EnvironmentPromotionUnavailableReason } from "@bb/server-contract";

export const PROMOTION_UNAVAILABLE_COPY: Record<
  EnvironmentPromotionUnavailableReason,
  string
> = {
  already_promoted: "This environment is already promoted.",
  different_host_or_source:
    "Promotion is only available for local worktree environments on this host.",
  environment_branch_mismatch:
    "Check out the environment branch before promoting.",
  environment_dirty: "Clean the environment worktree before continuing.",
  environment_not_ready:
    "Promotion is available after the environment is ready.",
  environment_status_unavailable: "Environment status is unavailable.",
  environment_is_primary_checkout:
    "This environment is already the primary checkout.",
  local_host_disconnected:
    "Promotion is available when the local host daemon is connected.",
  missing_default_branch: "Demotion needs the environment default branch.",
  missing_environment_branch: "Promotion needs an environment branch.",
  not_promoted: "This environment is not promoted.",
  primary_checkout_dirty: "Clean the primary checkout before continuing.",
  primary_checkout_status_unavailable:
    "Primary checkout status is unavailable.",
  unsupported_workspace:
    "Promotion is only available for local worktree environments on this host.",
};
