import { useEffect, useState, type ReactNode } from "react";
import { ChevronUp } from "lucide-react";
import type { ActiveThinking, ThreadRuntimeDisplayStatus } from "@bb/domain";
import type { TimelineRow, TimelineTurnRow } from "@bb/server-contract";
import {
  ConversationTimeline,
  ThreadTimelineRows,
  type ThreadTimelineLocalFileLinkHandler,
  type TimelineTitleActionResolver,
} from "@bb/ui-core";
import { PageShell } from "@bb/ui-core";
import { Button } from "@bb/ui-core";
import { ConversationStatusIndicator } from "@bb/ui-core";
import { ConversationWorkingIndicator } from "@bb/ui-core";
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

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden">
      {header}
      <PageShell
        key={threadId}
        scrollBehavior="bottom-anchor"
        shellClassName="!mx-0 !mt-0 md:!mx-0 md:!mt-0"
        contentClassName="min-h-full gap-2 pt-0"
        footerClassName="chat-prompt-box"
        footer={footer}
      >
        <ConversationTimeline className="flex-1">
          {hasOlderTimelineRows &&
          !isThreadTimelinePending &&
          !timelineError ? (
            <div className="flex justify-center pt-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={onLoadOlderRows}
                disabled={isLoadingOlderTimelineRows}
              >
                <ChevronUp aria-hidden="true" />
                {isLoadingOlderTimelineRows
                  ? "Loading older rows..."
                  : "Load older rows"}
              </Button>
            </div>
          ) : null}
          {isThreadTimelinePending ? (
            <DelayedThreadLoadingIndicator />
          ) : timelineError ? (
            <ConversationStatusIndicator
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
            />
          ) : null}
          {hostConnectionNotice ? (
            <ConversationStatusIndicator
              label={hostConnectionNotice.label}
              className={
                hostConnectionNotice.tone === "error"
                  ? "mt-4 text-destructive"
                  : "mt-4"
              }
            />
          ) : null}
          {showOngoingIndicator ? (
            <ConversationWorkingIndicator
              key={ongoingIndicatorKey}
              details={activeThinkingDetails}
              isThinking={showActiveThinking}
              label={ongoingIndicatorLabel}
            />
          ) : null}
        </ConversationTimeline>
      </PageShell>
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
    <ConversationStatusIndicator label="Loading thread..." className="mt-6" />
  );
}
