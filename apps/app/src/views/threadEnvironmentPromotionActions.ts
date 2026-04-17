import {
  findLocalPathProjectSourceForHost,
  type Environment,
  type LocalPathProjectSource,
  type ProjectSource,
} from "@bb/domain";
import type {
  EnvironmentPromotionActionAvailability,
  EnvironmentPromotionUnavailableReason,
} from "@bb/server-contract";
import type {
  ThreadEnvironmentPromotionDialogTarget,
} from "@/components/thread/ThreadEnvironmentPromotionDialog";

export interface ThreadEnvironmentPromotionHeaderAction {
  disabled: boolean;
  label: string;
  target: ThreadEnvironmentPromotionDialogTarget;
  title: string;
}

interface LocalUnavailableReasonArgs {
  environment: Environment;
  hasConnectedPersistentHost: boolean;
  isEnvironmentLocal: boolean;
  localSource: LocalPathProjectSource | null;
}

interface ResolveHeaderActionArgs {
  actionAvailability?: EnvironmentPromotionActionAvailability;
  isLoading: boolean;
  isPending: boolean;
  isPromoted: boolean;
  localUnavailableReason: EnvironmentPromotionUnavailableReason | null;
}

const PROMOTION_UNAVAILABLE_COPY: Record<EnvironmentPromotionUnavailableReason, string> = {
  already_promoted: "This environment is already promoted.",
  different_host_or_source: "Promotion is only available for local worktree environments on this host.",
  environment_branch_mismatch: "Check out the environment branch before promoting.",
  environment_dirty: "Clean the environment worktree before continuing.",
  environment_not_ready: "Promotion is available after the environment is ready.",
  environment_status_unavailable: "Environment status is unavailable.",
  environment_is_primary_checkout: "This environment is already the primary checkout.",
  local_host_disconnected: "Promotion is available when the local host daemon is connected.",
  missing_default_branch: "Demotion needs the environment default branch.",
  missing_environment_branch: "Promotion needs an environment branch.",
  not_promoted: "This environment is not promoted.",
  primary_checkout_dirty: "Clean the primary checkout before continuing.",
  primary_checkout_status_unavailable: "Primary checkout status is unavailable.",
  unsupported_workspace: "Promotion is only available for local worktree environments on this host.",
};

const CHECKING_PROMOTION_STATUS_COPY = "Checking promotion status.";
const PROMOTION_PENDING_COPY = "Promotion action is running.";

export function findPromotionProjectSourceForHost(
  sources: ProjectSource[],
  hostId: string | null,
): LocalPathProjectSource | null {
  if (!hostId) {
    return null;
  }
  return findLocalPathProjectSourceForHost(sources, hostId) ?? null;
}

export function getThreadPromotionLocalUnavailableReason({
  environment,
  hasConnectedPersistentHost,
  isEnvironmentLocal,
  localSource,
}: LocalUnavailableReasonArgs): EnvironmentPromotionUnavailableReason | null {
  if (!hasConnectedPersistentHost) {
    return "local_host_disconnected";
  }
  if (environment.status !== "ready" || environment.path === null) {
    return "environment_not_ready";
  }
  if (!environment.branchName) {
    return "missing_environment_branch";
  }
  if (!isEnvironmentLocal || !localSource) {
    return "different_host_or_source";
  }
  if (!environment.isGitRepo || environment.workspaceProvisionType !== "managed-worktree") {
    return "unsupported_workspace";
  }
  return null;
}

export function resolveThreadPromotionHeaderAction({
  actionAvailability,
  isLoading,
  isPending,
  isPromoted,
  localUnavailableReason,
}: ResolveHeaderActionArgs): ThreadEnvironmentPromotionHeaderAction {
  const target: ThreadEnvironmentPromotionDialogTarget = isPromoted
    ? { kind: "demote" }
    : { kind: "promote" };
  const label = isPromoted ? "Demote" : "Promote";

  if (isPending) {
    return {
      disabled: true,
      label,
      target,
      title: PROMOTION_PENDING_COPY,
    };
  }
  if (localUnavailableReason) {
    return {
      disabled: true,
      label,
      target,
      title: PROMOTION_UNAVAILABLE_COPY[localUnavailableReason],
    };
  }
  if (isLoading || !actionAvailability) {
    return {
      disabled: true,
      label,
      target,
      title: CHECKING_PROMOTION_STATUS_COPY,
    };
  }
  if (!actionAvailability.enabled) {
    return {
      disabled: true,
      label,
      target,
      title: actionAvailability.unavailableReason
        ? PROMOTION_UNAVAILABLE_COPY[actionAvailability.unavailableReason]
        : CHECKING_PROMOTION_STATUS_COPY,
    };
  }
  return {
    disabled: false,
    label,
    target,
    title: label,
  };
}
