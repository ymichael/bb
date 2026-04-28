import { useEffect, useState, type ReactNode } from "react";
import type {
  TimelineActiveThinking,
  TimelineRow,
  TimelineTurnSummaryRow,
} from "@bb/domain";
import { ConversationTimeline, ThreadTimelineRows } from "@bb/ui-core";
import { PageShell } from "@/components/layout/PageShell";
import { ConversationStatusIndicator } from "@/components/messages/ConversationStatusIndicator";
import { ConversationWorkingIndicator } from "@/components/messages/ConversationWorkingIndicator";
import { usePreferredTheme } from "@/hooks/useTheme";
import { toUserAttachmentImageSrc } from "@/lib/user-attachment-images";

interface ThreadTimelinePaneProps {
  activeThinking: TimelineActiveThinking | null;
  footer: ReactNode;
  header: ReactNode;
  isThreadTimelinePending: boolean;
  timelineError: boolean;
  latestActivityRowId: string | null;
  loadingTurnSummaryIds: ReadonlySet<string>;
  erroredTurnSummaryIds: ReadonlySet<string>;
  onLoadTurnSummaryRows: (entry: TimelineTurnSummaryRow) => void;
  projectId?: string;
  showOngoingIndicator: boolean;
  ongoingIndicatorLabel?: string;
  threadDetailRows: TimelineRow[];
  threadId: string;
  threadStatus: string;
  turnSummaryRowsById: Record<string, TimelineRow[]>;
}

export function ThreadTimelinePane({
  activeThinking,
  footer,
  header,
  isThreadTimelinePending,
  timelineError,
  latestActivityRowId,
  loadingTurnSummaryIds,
  erroredTurnSummaryIds,
  onLoadTurnSummaryRows,
  projectId,
  showOngoingIndicator,
  ongoingIndicatorLabel,
  threadDetailRows,
  threadId,
  threadStatus,
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
        scrollBehavior="stick-to-bottom"
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
              projectId={projectId}
              resolveUserAttachmentImageSrc={toUserAttachmentImageSrc}
              themeType={preferredTheme}
              threadDetailRows={threadDetailRows}
              threadStatus={threadStatus}
              turnSummaryRowsById={turnSummaryRowsById}
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
