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
import { PROMOTION_UNAVAILABLE_COPY } from "@/lib/promotion-copy";
import type { ThreadEnvironmentPromotionDialogTarget } from "@/components/thread/dialogs/ThreadEnvironmentPromotionDialog";

export type ThreadEnvironmentPromotionHeaderAction =
  | { kind: "hard-disabled"; label: string; tooltip: string }
  | {
      kind: "enabled";
      label: string;
      target: ThreadEnvironmentPromotionDialogTarget;
      blockers: EnvironmentPromotionUnavailableReason[];
    };

interface LocalUnavailableReasonArgs {
  environment: Environment;
  hasConnectedPersistentHost: boolean;
  isEnvironmentLocal: boolean;
  localSource: LocalPathProjectSource | null;
}

interface ResolveHeaderActionArgs {
  actionAvailability?: EnvironmentPromotionActionAvailability;
  isAgentActive: boolean;
  isLoading: boolean;
  isPending: boolean;
  isPromoted: boolean;
  localUnavailableReason: EnvironmentPromotionUnavailableReason | null;
}

const STRUCTURAL_HIDDEN_REASONS: ReadonlySet<EnvironmentPromotionUnavailableReason> =
  new Set([
    "different_host_or_source",
    "environment_is_primary_checkout",
    "unsupported_workspace",
  ]);

const HARD_DISABLE_REASONS: ReadonlySet<EnvironmentPromotionUnavailableReason> =
  new Set([
    "environment_status_unavailable",
    "local_host_disconnected",
    "primary_checkout_status_unavailable",
  ]);

const TOOLTIP_PENDING = "Promotion action is running.";
const TOOLTIP_AGENT_ACTIVE =
  "Promotion is unavailable while the agent is running.";
const TOOLTIP_LOADING = "Checking promotion status.";

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
  if (
    !environment.isGitRepo ||
    environment.workspaceProvisionType !== "managed-worktree"
  ) {
    return "unsupported_workspace";
  }
  return null;
}

export function resolveThreadPromotionHeaderAction({
  actionAvailability,
  isAgentActive,
  isLoading,
  isPending,
  isPromoted,
  localUnavailableReason,
}: ResolveHeaderActionArgs): ThreadEnvironmentPromotionHeaderAction | null {
  const reasons: EnvironmentPromotionUnavailableReason[] = localUnavailableReason
    ? [localUnavailableReason]
    : (actionAvailability?.unavailableReasons ?? []);

  if (reasons.some((reason) => STRUCTURAL_HIDDEN_REASONS.has(reason))) {
    return null;
  }

  const target: ThreadEnvironmentPromotionDialogTarget = isPromoted
    ? { kind: "demote" }
    : { kind: "promote" };
  const label = isPromoted ? "Demote" : "Promote";

  if (isPending) {
    return { kind: "hard-disabled", label, tooltip: TOOLTIP_PENDING };
  }
  if (isAgentActive) {
    return { kind: "hard-disabled", label, tooltip: TOOLTIP_AGENT_ACTIVE };
  }
  const hardReason = reasons.find((reason) =>
    HARD_DISABLE_REASONS.has(reason),
  );
  if (hardReason) {
    return {
      kind: "hard-disabled",
      label,
      tooltip: PROMOTION_UNAVAILABLE_COPY[hardReason],
    };
  }
  if (isLoading || (!localUnavailableReason && !actionAvailability)) {
    return { kind: "hard-disabled", label, tooltip: TOOLTIP_LOADING };
  }

  return { kind: "enabled", label, target, blockers: reasons };
}
