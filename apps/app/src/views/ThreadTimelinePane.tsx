import { type ReactNode } from "react";
import type {
  TimelineActiveThinking,
  TimelineRow,
  TimelineTurnSummaryRow,
} from "@bb/domain";
import {
  ConversationEmptyState,
  ConversationTimeline,
  ThreadTimelineRows,
} from "@bb/ui-core";
import { PageShell } from "@/components/layout/PageShell";
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
  onLoadTurnSummaryRows: (entry: TimelineTurnSummaryRow) => void;
  onScroll: () => void;
  projectId?: string;
  scrollRef: (element: HTMLDivElement | null) => void;
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
  onLoadTurnSummaryRows,
  onScroll,
  projectId,
  scrollRef,
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
        scrollRef={scrollRef}
        onScroll={onScroll}
        shellClassName="!mx-0 !mt-0 md:!mx-0 md:!mt-0"
        contentClassName="gap-2 pt-0"
        footerUsesPromptPadding
        footer={footer}
      >
        <ConversationTimeline>
          {isThreadTimelinePending ? (
            <ConversationWorkingIndicator
              label="Loading thread..."
              className="mt-6"
            />
          ) : timelineError ? (
            <div className="mt-6 px-2 text-sm text-destructive">
              Failed to load timeline
            </div>
          ) : threadDetailRows.length === 0 ? (
            <ConversationEmptyState message="No events yet" />
          ) : (
            <ThreadTimelineRows
              latestActivityRowId={latestActivityRowId}
              loadingTurnSummaryIds={loadingTurnSummaryIds}
              onLoadTurnSummaryRows={onLoadTurnSummaryRows}
              projectId={projectId}
              resolveUserAttachmentImageSrc={toUserAttachmentImageSrc}
              themeType={preferredTheme}
              threadDetailRows={threadDetailRows}
              threadStatus={threadStatus}
              turnSummaryRowsById={turnSummaryRowsById}
            />
          )}
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
