import { useEffect, useState, type ReactNode } from "react";
import type {
  ActiveThinking,
  ThreadRuntimeDisplayStatus,
  TimelineRow,
  TimelineTurnSummaryRow,
} from "@bb/domain";
import {
  ConversationTimeline,
  ThreadTimelineRows,
  type ThreadTimelineLocalFileLinkHandler,
} from "@bb/ui-core";
import { PageShell } from "@/components/layout/PageShell";
import { ConversationStatusIndicator } from "@/components/messages/ConversationStatusIndicator";
import { ConversationWorkingIndicator } from "@/components/messages/ConversationWorkingIndicator";
import { usePreferredTheme } from "@/hooks/useTheme";
import { toUserAttachmentImageSrc } from "@/lib/user-attachment-images";

interface ThreadTimelinePaneProps {
  activeThinking: ActiveThinking | null;
  footer: ReactNode;
  header: ReactNode;
  hostConnectionNotice?: HostConnectionNotice | null;
  isThreadTimelinePending: boolean;
  timelineError: boolean;
  latestActivityRowId: string | null;
  loadingTurnSummaryIds: ReadonlySet<string>;
  erroredTurnSummaryIds: ReadonlySet<string>;
  onLoadTurnSummaryRows: (entry: TimelineTurnSummaryRow) => void;
  onOpenLocalFileLink?: ThreadTimelineLocalFileLinkHandler;
  projectId?: string;
  showOngoingIndicator: boolean;
  ongoingIndicatorLabel?: string;
  threadDetailRows: TimelineRow[];
  threadId: string;
  threadRuntimeDisplayStatus: ThreadRuntimeDisplayStatus;
  turnSummaryRowsById: Record<string, TimelineRow[]>;
}

export interface HostConnectionNotice {
  label: string;
  tone: "pending" | "error";
}

export function ThreadTimelinePane({
  activeThinking,
  footer,
  header,
  hostConnectionNotice,
  isThreadTimelinePending,
  timelineError,
  latestActivityRowId,
  loadingTurnSummaryIds,
  erroredTurnSummaryIds,
  onLoadTurnSummaryRows,
  onOpenLocalFileLink,
  projectId,
  showOngoingIndicator,
  ongoingIndicatorLabel,
  threadDetailRows,
  threadId,
  threadRuntimeDisplayStatus,
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
        footerUsesPromptPadding
        footer={footer}
      >
        <ConversationTimeline className="flex-1">
          {isThreadTimelinePending ? (
            <DelayedThreadLoadingIndicator />
          ) : timelineError ? (
            <ConversationStatusIndicator
              label="Failed to load timeline"
              className="mt-6 text-destructive"
            />
          ) : threadDetailRows.length > 0 ? (
            <ThreadTimelineRows
              latestActivityRowId={latestActivityRowId}
              loadingTurnSummaryIds={loadingTurnSummaryIds}
              erroredTurnSummaryIds={erroredTurnSummaryIds}
              onLoadTurnSummaryRows={onLoadTurnSummaryRows}
              onOpenLocalFileLink={onOpenLocalFileLink}
              projectId={projectId}
              resolveUserAttachmentImageSrc={toUserAttachmentImageSrc}
              themeType={preferredTheme}
              threadDetailRows={threadDetailRows}
              threadRuntimeDisplayStatus={threadRuntimeDisplayStatus}
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
        </ConversationTimeline>
        {showOngoingIndicator ? (
          <ConversationWorkingIndicator
            key={ongoingIndicatorKey}
            details={activeThinkingDetails}
            isThinking={showActiveThinking}
            label={ongoingIndicatorLabel}
          />
        ) : null}
      </PageShell>
    </div>
  );
}

// Delay before revealing the loading indicator so fast loads don't flash.
const LOADING_INDICATOR_REVEAL_DELAY_MS = 200;

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
    <ConversationWorkingIndicator label="Loading thread..." className="mt-6" />
  );
}
