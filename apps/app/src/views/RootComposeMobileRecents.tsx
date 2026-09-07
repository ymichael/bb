import { useCallback, useEffect, useMemo } from "react";
import { useAtom } from "jotai";
import type { ProviderInfo, ThreadListEntry } from "@bb/domain";
import { RouteAnchor } from "@/components/ui/app-route-anchor";
import { ThreadStatusGlyph } from "@/components/sidebar/ThreadRow";
import { SidebarChildToggleChevron } from "@/components/sidebar/SidebarChildToggleChevron";
import { getSidebarThreadRowPaddingLeft } from "@/components/sidebar/sidebarRowClasses";
import { SIDEBAR_WORKING_STATUS_COLOR_CLASS } from "@/components/sidebar/sidebarRowClasses";
import { CHROME_SECTION_LABEL_CLASS } from "@bb/shared-ui/chrome-style-tokens";
import {
  COARSE_POINTER_ICON_SIZE_CLASS,
  COARSE_POINTER_TEXT_BASE_CLASS,
  COARSE_POINTER_TEXT_SM_CLASS,
} from "@bb/shared-ui/coarse-pointer-sizing";
import { Icon } from "@bb/shared-ui/icon";
import { OverflowFade } from "@/components/ui/overflow-fade";
import { getThreadRoutePath, isProjectlessProjectId } from "@/lib/route-paths";
import {
  hasActiveBackgroundAgentActivity,
  hasActiveBackgroundCommandActivity,
  hasActiveGoalActivity,
  hasActivePlanModeActivity,
  hasActiveWorkflowActivity,
  getThreadListIndicatorLabel,
  isRuntimeBusyThread,
  isUnreadDoneThread,
  resolveThreadListIndicator,
  buildChronologicalThreadList,
  type CollapsedChildActivity,
  type ProjectThreadItem,
  type ThreadListIndicatorState,
} from "@bb/client-core";
import { getThreadDisplayTitle } from "@/lib/thread-title";
import { formatRelativeTime } from "@/lib/relative-time";
import { getEnvironmentWorkspaceDisplayIconName } from "@/lib/environment-workspace-display";
import { getProviderIconInfo } from "@/lib/provider-icon";
import { ProviderIconMark } from "@/components/settings/ProviderIconMark";
import { cn } from "@bb/shared-ui/lib/utils";
import { usePromptDraftInputThreadIds } from "@/hooks/usePromptDraftStorage";
import { collapsedThreadIdsAtom } from "@/components/sidebar/sidebarCollapsedAtoms";

export const MOBILE_RECENT_ROW_HEIGHT_PX = 60;
export const MOBILE_RECENT_LABEL_HEIGHT_PX = 24;

const MOBILE_RECENT_ROW_HEIGHT_CLASS = "h-15";

type ThreadListEntryComparator = (
  left: ThreadListEntry,
  right: ThreadListEntry,
) => number;

interface GetMobileRecentThreadsArgs {
  collapsedThreadIds: ReadonlySet<string>;
  draftThreadIds: ReadonlySet<string>;
  threads: readonly ThreadListEntry[];
}

interface MobileRecentThreadRowProps {
  highlighted: boolean;
  onToggleCollapsed: (threadId: string) => void;
  projectName: string | null;
  provider: ProviderInfo | null;
  row: MobileRecentThreadRow;
}

function getMobileRecentThreadMetadata({
  projectName,
  thread,
}: {
  projectName: string | null;
  thread: ThreadListEntry;
}): string {
  const workspaceName = thread.environmentBranchName ?? thread.environmentName;
  return [
    projectName,
    workspaceName,
    formatRelativeTime({
      timestamp: thread.latestAttentionAt,
      now: Date.now(),
    }),
  ]
    .filter((part): part is string => part !== null && part.length > 0)
    .join(" \u00b7 ");
}

interface RootComposeMobileRecentsProps {
  highlightedThreadId: string | null;
  projectNamesById: ReadonlyMap<string, string>;
  providersById: ReadonlyMap<string, ProviderInfo>;
  showCreatingRow: boolean;
  threads: readonly ThreadListEntry[];
}

const compareMobileRecentThreads: ThreadListEntryComparator = (left, right) => {
  const latestAttentionAtDelta =
    right.latestAttentionAt - left.latestAttentionAt;
  if (latestAttentionAtDelta !== 0) {
    return latestAttentionAtDelta;
  }

  const createdAtDelta = right.createdAt - left.createdAt;
  if (createdAtDelta !== 0) {
    return createdAtDelta;
  }

  return left.id.localeCompare(right.id);
};

export interface MobileRecentThreadRow {
  thread: ThreadListEntry;
  depth: number;
  childActivity: CollapsedChildActivity;
  hasUnsubmittedDraft: boolean;
  hasChildren: boolean;
  isCollapsed: boolean;
}

function flattenMobileRecentNodes({
  collapsedThreadIds,
  draftThreadIds,
  items,
  rows,
}: {
  collapsedThreadIds: ReadonlySet<string>;
  draftThreadIds: ReadonlySet<string>;
  items: readonly ProjectThreadItem[];
  rows: MobileRecentThreadRow[];
}): void {
  for (const item of items) {
    if (item.kind !== "thread") continue;
    const { node } = item;
    const hasChildren = node.children.length > 0;
    const isCollapsed = hasChildren && collapsedThreadIds.has(node.thread.id);
    rows.push({
      thread: node.thread,
      depth: node.depth,
      childActivity: node.stats.childActivity,
      hasUnsubmittedDraft: draftThreadIds.has(node.thread.id),
      hasChildren,
      isCollapsed,
    });
    if (hasChildren && !isCollapsed) {
      flattenMobileRecentNodes({
        collapsedThreadIds,
        draftThreadIds,
        items: node.children,
        rows,
      });
    }
  }
}

export function getMobileRecentAncestorIds({
  threadId,
  threads,
}: {
  threadId: string;
  threads: readonly ThreadListEntry[];
}): string[] {
  const byId = new Map(threads.map((thread) => [thread.id, thread]));
  const selected = byId.get(threadId);
  if (selected === undefined || selected.visibility === "hidden") {
    return [];
  }

  const ancestorIds: string[] = [];
  let current: ThreadListEntry | undefined = selected;
  let remainingHops = byId.size;
  while (current !== undefined && remainingHops > 0) {
    const parentThreadId: string | null = current.parentThreadId;
    if (parentThreadId === null) break;
    const parent = byId.get(parentThreadId);
    if (parent === undefined) break;
    ancestorIds.push(parent.id);
    current = parent;
    remainingHops -= 1;
  }
  return ancestorIds;
}

export function getMobileRecentThreads({
  collapsedThreadIds,
  draftThreadIds,
  threads,
}: GetMobileRecentThreadsArgs): MobileRecentThreadRow[] {
  const rows: MobileRecentThreadRow[] = [];
  flattenMobileRecentNodes({
    collapsedThreadIds,
    draftThreadIds,
    items: buildChronologicalThreadList(
      threads,
      compareMobileRecentThreads,
      draftThreadIds,
    ),
    rows,
  });
  return rows;
}

function MobileRecentThreadRow({
  highlighted,
  onToggleCollapsed,
  projectName,
  provider,
  row,
}: MobileRecentThreadRowProps) {
  const {
    thread,
    depth,
    childActivity,
    hasUnsubmittedDraft,
    hasChildren,
    isCollapsed,
  } = row;
  const threadTitle = getThreadDisplayTitle(thread);
  const isUnreadDone = isUnreadDoneThread(thread);
  const isUnreadError = isUnreadDone && thread.status === "error";
  const indicatorState: ThreadListIndicatorState = {
    hasPendingInteraction: thread.hasPendingInteraction,
    hasUnsubmittedDraft,
    hasUnreadError: isUnreadError,
    hasUnreadSuccess: isUnreadDone && !isUnreadError,
    isBackgroundAgentActive: hasActiveBackgroundAgentActivity(thread),
    isBackgroundCommandActive: hasActiveBackgroundCommandActivity(thread),
    isGoalActive: hasActiveGoalActivity(thread),
    queuedWork: thread.queuedWork,
    isPlanModeActive: hasActivePlanModeActivity(thread),
    isRuntimeActive: isRuntimeBusyThread(thread),
    isWorkflowActive: hasActiveWorkflowActivity(thread),
  };
  const hasHiddenChildren = hasChildren && isCollapsed;
  const trailingIndicatorState: ThreadListIndicatorState = hasHiddenChildren
    ? {
        hasPendingInteraction:
          indicatorState.hasPendingInteraction || childActivity.pending,
        hasUnsubmittedDraft:
          indicatorState.hasUnsubmittedDraft ||
          childActivity.hasUnsubmittedDraft,
        hasUnreadError:
          indicatorState.hasUnreadError || childActivity.unreadError,
        hasUnreadSuccess:
          indicatorState.hasUnreadSuccess ||
          (childActivity.unread && !childActivity.unreadError),
        isBackgroundAgentActive:
          indicatorState.isBackgroundAgentActive ||
          childActivity.backgroundAgent,
        isBackgroundCommandActive:
          indicatorState.isBackgroundCommandActive ||
          childActivity.backgroundCommand,
        isGoalActive: indicatorState.isGoalActive || childActivity.goal,
        queuedWork: indicatorState.queuedWork,
        isPlanModeActive:
          indicatorState.isPlanModeActive || childActivity.planMode,
        isRuntimeActive:
          indicatorState.isRuntimeActive || childActivity.runtimeWorking,
        isWorkflowActive:
          indicatorState.isWorkflowActive || childActivity.workflow,
      }
    : indicatorState;
  const indicatorKind = resolveThreadListIndicator(trailingIndicatorState);
  const indicatorLabel = getThreadListIndicatorLabel(indicatorKind);
  const metadataText = getMobileRecentThreadMetadata({ projectName, thread });
  const workspaceIconName = getEnvironmentWorkspaceDisplayIconName(
    thread.environmentWorkspaceDisplayKind,
  );
  const providerIcon = getProviderIconInfo(thread.providerId, provider);
  const ProviderMark = providerIcon?.icon;
  return (
    <li
      className={cn(
        "flex items-center rounded-md pr-2",
        MOBILE_RECENT_ROW_HEIGHT_CLASS,
        highlighted && "bg-surface-selected",
      )}
    >
      <RouteAnchor
        href={getThreadRoutePath({
          projectId: thread.projectId,
          threadId: thread.id,
        })}
        aria-label={`Open ${threadTitle}${indicatorLabel ? ` — ${indicatorLabel}` : ""}`}
        style={{ paddingLeft: getSidebarThreadRowPaddingLeft(depth) }}
        className={cn(
          "flex min-w-0 flex-1 items-center gap-2.5 rounded-md text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
          MOBILE_RECENT_ROW_HEIGHT_CLASS,
        )}
      >
        <span
          className={cn(
            "flex size-7 shrink-0 items-center justify-center rounded-md border border-border-seam bg-surface-raised",
            depth > 0 && "opacity-60",
          )}
        >
          {ProviderMark === undefined ? null : provider === null ? (
            <ProviderMark className="size-4" />
          ) : (
            <ProviderIconMark
              provider={provider}
              icon={ProviderMark}
              className="size-4"
            />
          )}
        </span>
        <span className="min-w-0 flex-1 space-y-0.5">
          <span className="flex min-w-0 items-center gap-1.5">
            <span
              className={cn(
                "min-w-0 truncate font-medium",
                COARSE_POINTER_TEXT_BASE_CLASS,
              )}
            >
              {threadTitle}
            </span>
          </span>
          <span
            className={cn(
              "flex min-w-0 items-center gap-1.5 leading-4 text-muted-foreground",
              COARSE_POINTER_TEXT_SM_CLASS,
            )}
            title={metadataText}
          >
            {workspaceIconName ? (
              <Icon
                name={workspaceIconName}
                className="size-3.5 shrink-0"
                aria-hidden="true"
              />
            ) : null}
            <span className="min-w-0 truncate">{metadataText}</span>
          </span>
        </span>
        {indicatorKind !== "none" ? (
          <span className="flex size-6 shrink-0 items-center justify-center">
            <ThreadStatusGlyph {...trailingIndicatorState} />
          </span>
        ) : null}
      </RouteAnchor>
      {hasChildren ? (
        <SidebarChildToggleChevron
          isCollapsed={isCollapsed}
          expandLabel={`Show threads under ${threadTitle}`}
          collapseLabel={`Hide threads under ${threadTitle}`}
          onToggle={() => onToggleCollapsed(thread.id)}
        />
      ) : null}
    </li>
  );
}

export function RootComposeMobileRecents({
  highlightedThreadId,
  projectNamesById,
  providersById,
  showCreatingRow,
  threads,
}: RootComposeMobileRecentsProps) {
  const [collapsedThreadIdList, setCollapsedThreadIdList] = useAtom(
    collapsedThreadIdsAtom,
  );
  const collapsedThreadIds = useMemo(
    () => new Set(collapsedThreadIdList),
    [collapsedThreadIdList],
  );
  const draftThreadIds = usePromptDraftInputThreadIds(threads);
  const toggleCollapsed = useCallback(
    (threadId: string) => {
      setCollapsedThreadIdList((current) =>
        current.includes(threadId)
          ? current.filter((id) => id !== threadId)
          : [...current, threadId],
      );
    },
    [setCollapsedThreadIdList],
  );
  useEffect(() => {
    if (highlightedThreadId === null) return;
    const ancestorIds = getMobileRecentAncestorIds({
      threadId: highlightedThreadId,
      threads,
    });
    if (ancestorIds.length === 0) return;
    setCollapsedThreadIdList((current) => {
      const next = current.filter((id) => !ancestorIds.includes(id));
      return next.length === current.length ? current : next;
    });
  }, [highlightedThreadId, setCollapsedThreadIdList, threads]);
  const recentThreads = useMemo(
    () =>
      getMobileRecentThreads({
        collapsedThreadIds,
        draftThreadIds,
        threads,
      }),
    [collapsedThreadIds, draftThreadIds, threads],
  );

  if (!showCreatingRow && recentThreads.length === 0) {
    return null;
  }

  return (
    <section
      data-root-compose-mobile-recents=""
      aria-labelledby="root-compose-mobile-recents"
      className="md:hidden"
    >
      <div className="sticky top-0 z-10 mb-1 bg-background px-2">
        <h2
          id="root-compose-mobile-recents"
          className={CHROME_SECTION_LABEL_CLASS}
        >
          Recent
        </h2>
        <OverflowFade placement="below" tone="background" size="sm" />
      </div>
      {showCreatingRow ? (
        <div
          role="status"
          className={cn(
            "flex items-center gap-2.5 rounded-md px-2 text-sm text-muted-foreground",
            MOBILE_RECENT_ROW_HEIGHT_CLASS,
          )}
        >
          <span className="min-w-0 flex-1 truncate">Creating thread</span>
          <span className="flex size-6 shrink-0 items-center justify-center">
            <Icon
              name="Loading"
              className={cn(
                "shrink-0 animate-spin",
                SIDEBAR_WORKING_STATUS_COLOR_CLASS,
                COARSE_POINTER_ICON_SIZE_CLASS,
              )}
              aria-hidden="true"
            />
          </span>
        </div>
      ) : null}
      {recentThreads.length > 0 ? (
        <ul className="space-y-px">
          {recentThreads.map((row) => (
            <MobileRecentThreadRow
              key={row.thread.id}
              highlighted={row.thread.id === highlightedThreadId}
              onToggleCollapsed={toggleCollapsed}
              provider={providersById.get(row.thread.providerId) ?? null}
              projectName={
                isProjectlessProjectId(row.thread.projectId)
                  ? null
                  : (projectNamesById.get(row.thread.projectId) ?? null)
              }
              row={row}
            />
          ))}
        </ul>
      ) : null}
    </section>
  );
}
