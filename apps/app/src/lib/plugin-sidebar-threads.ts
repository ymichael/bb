import type { ThreadListEntry } from "@bb/domain";
import type {
  PluginSidebarThread,
  PluginSidebarThreadIndicator,
} from "@get-bb/plugin-sdk";
import {
  getThreadListIndicatorLabel,
  hasActiveBackgroundAgentActivity,
  hasActiveBackgroundCommandActivity,
  hasActiveGoalActivity,
  hasActivePlanModeActivity,
  hasActiveWorkflowActivity,
  isRuntimeBusyThread,
  isUnreadDoneThread,
  resolveThreadListIndicator,
} from "@bb/client-core";
import { isThreadRead } from "@bb/client-core";

export function toPluginSidebarThread(
  entry: ThreadListEntry,
  hostNamesById: ReadonlyMap<string, string> = new Map(),
): PluginSidebarThread {
  const isUnreadDone = isUnreadDoneThread(entry);
  const hasUnreadError = isUnreadDone && entry.status === "error";
  const resolvedIndicator = resolveThreadListIndicator({
    hasPendingInteraction: entry.hasPendingInteraction,
    hasUnsubmittedDraft: false,
    hasUnreadError,
    hasUnreadSuccess: isUnreadDone && !hasUnreadError,
    isBackgroundAgentActive: hasActiveBackgroundAgentActivity(entry),
    isBackgroundCommandActive: hasActiveBackgroundCommandActivity(entry),
    isGoalActive: hasActiveGoalActivity(entry),
    queuedWork: entry.queuedWork,
    isPlanModeActive: hasActivePlanModeActivity(entry),
    isRuntimeActive: isRuntimeBusyThread(entry),
    isWorkflowActive: hasActiveWorkflowActivity(entry),
  });
  const indicator: PluginSidebarThreadIndicator =
    resolvedIndicator === "queued-waiting" ||
    resolvedIndicator === "queued-failed"
      ? "none"
      : resolvedIndicator;

  return {
    id: entry.id,
    projectId: entry.projectId,
    title: entry.title,
    titleFallback: entry.titleFallback,
    parentThreadId: entry.parentThreadId,
    sectionId: entry.sectionId,
    originKind: entry.originKind,
    originPluginId: entry.originPluginId,
    providerId: entry.providerId,
    hasPendingInteraction: entry.hasPendingInteraction,
    activity: {
      workflows: entry.activity.activeWorkflowCount,
      backgroundAgents: entry.activity.activeBackgroundAgentCount,
      backgroundCommands: entry.activity.activeBackgroundCommandCount,
      planMode: entry.activity.activePlanModeCount,
      goals: entry.activity.activeGoalCount,
    },
    indicator,
    indicatorLabel: getThreadListIndicatorLabel(indicator),
    isUnread: !isThreadRead(entry),
    isPinned: entry.pinnedAt !== null,
    isArchived: entry.archivedAt !== null,
    environment:
      entry.environmentId === null
        ? null
        : {
            id: entry.environmentId,
            name: entry.environmentName,
            branchName: entry.environmentBranchName,
            workspaceDisplayKind: entry.environmentWorkspaceDisplayKind,
          },
    host:
      entry.environmentHostId === null
        ? null
        : {
            id: entry.environmentHostId,
            name:
              hostNamesById.get(entry.environmentHostId) ??
              entry.environmentHostId,
          },
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    lastReadAt: entry.lastReadAt,
    latestAttentionAt: entry.latestAttentionAt,
  };
}
