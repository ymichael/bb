import { useCallback, useEffect, useState, type ReactNode } from "react";
import type { ActiveThinking, ThreadRuntimeDisplayStatus } from "@bb/domain";
import type { TimelineRow, TimelineTurnRow } from "@bb/server-contract";
import { Button } from "@/components/ui/button.js";
import { ConversationTimeline } from "@/components/ui/conversation.js";
import {
  HEIGHT_TRANSITION_DURATION_MS,
  HeightTransition,
} from "@/components/ui/height-transition.js";
import { Icon } from "@/components/ui/icon.js";
import { PageShell } from "@/components/ui/page-shell.js";
import { useBottomAnchoredScroll } from "@/components/ui/bottom-anchored-scroll-body.js";
import { useTrailingVisible } from "@/hooks/useTrailingVisible";
import {
  ThreadTimelineRows,
  type ThreadTimelineLocalFileLinkHandler,
  type TimelineTitleActionResolver,
} from "@/components/thread/timeline";
import { TimelineStatusIndicator } from "@/components/thread/timeline";
import { TimelineWorkingIndicator } from "@/components/thread/timeline";
import { usePreferredTheme } from "@/hooks/useTheme";
import { toUserAttachmentImageSrc } from "@/lib/user-attachment-images";

interface ThreadTimelinePaneProps {
  activeThinking: ActiveThinking | null;
  footer: ReactNode;
  hasOlderTimelineRows: boolean;
  header: ReactNode;
  hostConnectionNotice?: HostConnectionNotice | null;
  isLoadingOlderTimelineRows: boolean;
  isThreadTimelinePending: boolean;
  timelineError: boolean;
  loadingTurnSummaryIds: ReadonlySet<string>;
  erroredTurnSummaryIds: ReadonlySet<string>;
  onLoadOlderRows: () => void;
  onLoadTurnSummaryRows: (entry: TimelineTurnRow) => void;
  onOpenLocalFileLink?: ThreadTimelineLocalFileLinkHandler;
  onTitleAction?: TimelineTitleActionResolver;
  projectId?: string;
  showOngoingIndicator: boolean;
  ongoingIndicatorLabel?: string;
  timelineRows: TimelineRow[];
  threadId: string;
  threadRuntimeDisplayStatus: ThreadRuntimeDisplayStatus;
  turnSummaryRowsIdentity: string;
  turnSummaryRowsById: Record<string, TimelineRow[]>;
  workspaceRootPath: string | undefined;
}

export interface HostConnectionNotice {
  label: string;
  tone: "pending" | "error";
}

export function ThreadTimelinePane({
  activeThinking,
  footer,
  hasOlderTimelineRows,
  header,
  hostConnectionNotice,
  isLoadingOlderTimelineRows,
  isThreadTimelinePending,
  timelineError,
  loadingTurnSummaryIds,
  erroredTurnSummaryIds,
  onLoadOlderRows,
  onLoadTurnSummaryRows,
  onOpenLocalFileLink,
  onTitleAction,
  projectId,
  showOngoingIndicator,
  ongoingIndicatorLabel,
  timelineRows,
  threadId,
  threadRuntimeDisplayStatus,
  turnSummaryRowsIdentity,
  turnSummaryRowsById,
  workspaceRootPath,
}: ThreadTimelinePaneProps) {
  const preferredTheme = usePreferredTheme();
  const showActiveThinking =
    activeThinking !== null && ongoingIndicatorLabel === undefined;
  const activeThinkingText = activeThinking?.text.trim() ?? "";
  const activeThinkingDetails =
    showActiveThinking && activeThinkingText.length > 0
      ? activeThinking?.text
      : undefined;
  const ongoingIndicatorKey =
    showActiveThinking && activeThinking
      ? activeThinking.id
      : (ongoingIndicatorLabel ?? "working");
  // The final assistant chunk and the displayStatus flip-off land in the same
  // React commit when a stream completes. Holding the indicator visible for
  // one transition window lets the rows wrapper finish growing into the final
  // content before this wrapper starts collapsing, so the two height changes
  // run in sequence instead of fighting each other under the bottom anchor.
  const heldShowOngoingIndicator = useTrailingVisible(
    showOngoingIndicator,
    HEIGHT_TRANSITION_DURATION_MS,
  );

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden">
      {header}
      <PageShell
        key={threadId}
        scrollBehavior="bottom-anchor"
        shellClassName="!mx-0 !mt-0 md:!mx-0 md:!mt-0"
        contentClassName="min-h-full gap-2 pt-4"
        footerClassName="chat-prompt-box"
        footer={footer}
      >
        <ConversationTimeline className="flex-1">
          {hasOlderTimelineRows &&
          !isThreadTimelinePending &&
          !timelineError ? (
            <LoadOlderMessagesButton
              isLoadingOlderTimelineRows={isLoadingOlderTimelineRows}
              onLoadOlderRows={onLoadOlderRows}
            />
          ) : null}
          {isThreadTimelinePending ? (
            <DelayedThreadLoadingIndicator />
          ) : timelineError ? (
            <TimelineStatusIndicator
              label="Failed to load timeline"
              className="mt-6 text-destructive"
            />
          ) : timelineRows.length > 0 ? (
            <ThreadTimelineRows
              loadingTurnSummaryIds={loadingTurnSummaryIds}
              erroredTurnSummaryIds={erroredTurnSummaryIds}
              onLoadTurnSummaryRows={onLoadTurnSummaryRows}
              onOpenLocalFileLink={onOpenLocalFileLink}
              onTitleAction={onTitleAction}
              projectId={projectId}
              resolveUserAttachmentImageSrc={toUserAttachmentImageSrc}
              themeType={preferredTheme}
              timelineRows={timelineRows}
              threadRuntimeDisplayStatus={threadRuntimeDisplayStatus}
              turnSummaryRowsIdentity={turnSummaryRowsIdentity}
              turnSummaryRowsById={turnSummaryRowsById}
              workspaceRootPath={workspaceRootPath}
            />
          ) : null}
          {hostConnectionNotice ? (
            <TimelineStatusIndicator
              label={hostConnectionNotice.label}
              className={
                hostConnectionNotice.tone === "error"
                  ? "mt-4 text-destructive"
                  : "mt-4"
              }
            />
          ) : null}
          <HeightTransition visible={heldShowOngoingIndicator}>
            <TimelineWorkingIndicator
              key={ongoingIndicatorKey}
              details={activeThinkingDetails}
              isThinking={showActiveThinking}
              label={ongoingIndicatorLabel}
            />
          </HeightTransition>
        </ConversationTimeline>
      </PageShell>
    </div>
  );
}

function LoadOlderMessagesButton({
  isLoadingOlderTimelineRows,
  onLoadOlderRows,
}: {
  isLoadingOlderTimelineRows: boolean;
  onLoadOlderRows: () => void;
}) {
  const bottomAnchor = useBottomAnchoredScroll();
  const handleClick = useCallback(() => {
    bottomAnchor?.captureScrollAnchor();
    onLoadOlderRows();
  }, [bottomAnchor, onLoadOlderRows]);

  return (
    <div className="flex justify-center pt-2 mb-3">
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={handleClick}
        disabled={isLoadingOlderTimelineRows}
      >
        <Icon name="ChevronUp" aria-hidden="true" />
        {isLoadingOlderTimelineRows
          ? "Loading older messages..."
          : "Load older messages"}
      </Button>
    </div>
  );
}

// Delay before revealing the loading indicator so fast loads don't flash.
export const LOADING_INDICATOR_REVEAL_DELAY_MS = 200;

function DelayedThreadLoadingIndicator() {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const id = window.setTimeout(
      () => setVisible(true),
      LOADING_INDICATOR_REVEAL_DELAY_MS,
    );
    return () => window.clearTimeout(id);
  }, []);

  if (!visible) {
    return null;
  }

  return (
    <TimelineStatusIndicator label="Loading thread..." className="mt-6" />
  );
}
