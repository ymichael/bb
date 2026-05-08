import { useCallback, useMemo } from "react";
import { type Environment, type Thread } from "@bb/domain";
import type { EnvironmentPromotionUnavailableReason } from "@bb/server-contract";
import { useDialogState } from "@/hooks/useDialogState";
import { useHostDaemon } from "@/hooks/useHostDaemon";
import { useEnvironmentPromotion } from "@/hooks/queries/environment-queries";
import { useProjects } from "@/hooks/queries/project-queries";
import type { ThreadEnvironmentPromotionDialogTarget } from "@/components/thread/dialogs/ThreadEnvironmentPromotionDialog";
import type { RequestEnvironmentActionMutationLike } from "./threadDetailMutationTypes";
import {
  findPromotionProjectSourceForHost,
  getThreadPromotionLocalUnavailableReason,
  resolveThreadPromotionHeaderAction,
} from "./threadEnvironmentPromotionActions";

interface UseThreadEnvironmentPromotionActionsParams {
  environment?: Environment;
  isAgentActive: boolean;
  requestEnvironmentAction: RequestEnvironmentActionMutationLike;
  thread?: Thread;
}

export function useThreadEnvironmentPromotionActions({
  environment,
  isAgentActive,
  requestEnvironmentAction,
  thread,
}: UseThreadEnvironmentPromotionActionsParams) {
  const promotionDialog =
    useDialogState<ThreadEnvironmentPromotionDialogTarget>();
  const { hasConnectedPersistentHost, isLocalHost, localHostId } =
    useHostDaemon();
  const { data: projects } = useProjects();
  const project = useMemo(
    () =>
      projects?.find((candidate) => candidate.id === thread?.projectId) ?? null,
    [projects, thread?.projectId],
  );
  const localSource = useMemo(
    () =>
      findPromotionProjectSourceForHost(project?.sources ?? [], localHostId),
    [localHostId, project?.sources],
  );
  const hasPromotionControl =
    Boolean(thread) &&
    thread?.type !== "manager" &&
    thread?.archivedAt === null &&
    Boolean(environment) &&
    environment?.managed === true;
  const isEnvironmentLocal = environment
    ? isLocalHost(environment.hostId)
    : false;
  const canResolveLocalSource =
    projects !== undefined ||
    !hasConnectedPersistentHost ||
    !isEnvironmentLocal;
  const localUnavailableReason =
    environment && hasPromotionControl && canResolveLocalSource
      ? getThreadPromotionLocalUnavailableReason({
          environment,
          hasConnectedPersistentHost,
          isEnvironmentLocal,
          localSource,
        })
      : null;
  const promotionQuery = useEnvironmentPromotion(environment?.id, {
    enabled:
      hasPromotionControl &&
      canResolveLocalSource &&
      localUnavailableReason === null,
  });
  const isPromotionStateLoading =
    (hasPromotionControl && !canResolveLocalSource) || promotionQuery.isLoading;
  const promotionState = promotionQuery.data?.state ?? {
    isPromoted: false,
    branchName: environment?.branchName ?? null,
  };
  const actionAvailability = promotionState.isPromoted
    ? promotionQuery.data?.actions.demote
    : promotionQuery.data?.actions.promote;
  const headerAction = useMemo(
    () =>
      hasPromotionControl
        ? resolveThreadPromotionHeaderAction({
            actionAvailability,
            isAgentActive,
            isLoading: isPromotionStateLoading,
            isPending: requestEnvironmentAction.isPending,
            isPromoted: promotionState.isPromoted,
            localUnavailableReason,
          })
        : null,
    [
      actionAvailability,
      hasPromotionControl,
      isAgentActive,
      isPromotionStateLoading,
      localUnavailableReason,
      promotionState.isPromoted,
      requestEnvironmentAction.isPending,
    ],
  );

  const handlePromotionAction = useCallback(
    async (target: ThreadEnvironmentPromotionDialogTarget) => {
      if (!environment) {
        return;
      }
      await requestEnvironmentAction.mutateAsync({
        id: environment.id,
        action: target.kind,
      });
    },
    [environment, requestEnvironmentAction],
  );

  const dialogTargetKind = promotionDialog.target?.kind ?? null;
  const dialogServerAvailability =
    dialogTargetKind === "demote"
      ? promotionQuery.data?.actions.demote
      : dialogTargetKind === "promote"
        ? promotionQuery.data?.actions.promote
        : undefined;
  const dialogBlockers: EnvironmentPromotionUnavailableReason[] =
    localUnavailableReason
      ? [localUnavailableReason]
      : (dialogServerAvailability?.unavailableReasons ?? []);

  return {
    branchName: promotionState.branchName,
    defaultBranch: environment?.defaultBranch ?? null,
    dialogBlockers,
    handlePromotionAction,
    headerAction,
    isPromoted: promotionState.isPromoted,
    isPromotionActionPending: requestEnvironmentAction.isPending,
    primaryCheckoutPath: localSource?.path,
    promotionDialog,
  };
}
