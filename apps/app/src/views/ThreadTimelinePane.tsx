import { type ReactNode, type RefObject } from "react";
import type { TimelineRow, TimelineToolGroupRow, ViewMessage } from "@bb/domain";
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
  bottomSentinelRef: RefObject<HTMLDivElement | null>;
  footer: ReactNode;
  header: ReactNode;
  isReasoningBlockActive: boolean;
  isThreadTimelinePending: boolean;
  latestActivityRowId: string | null;
  loadingToolGroupIds: ReadonlySet<string>;
  onLoadToolGroupMessages: (entry: TimelineToolGroupRow) => void;
  onScroll: () => void;
  projectId?: string;
  scrollRef: (element: HTMLDivElement | null) => void;
  showOngoingIndicator: boolean;
  ongoingIndicatorLabel?: string;
  threadDetailRows: TimelineRow[];
  threadId: string;
  threadStatus: string;
  toolGroupMessagesById: Record<string, ViewMessage[]>;
}

export function ThreadTimelinePane({
  bottomSentinelRef,
  footer,
  header,
  isReasoningBlockActive,
  isThreadTimelinePending,
  latestActivityRowId,
  loadingToolGroupIds,
  onLoadToolGroupMessages,
  onScroll,
  projectId,
  scrollRef,
  showOngoingIndicator,
  ongoingIndicatorLabel,
  threadDetailRows,
  threadId,
  threadStatus,
  toolGroupMessagesById,
}: ThreadTimelinePaneProps) {
  const preferredTheme = usePreferredTheme();

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
            <ConversationWorkingIndicator label="Loading thread..." className="mt-6" />
          ) : threadDetailRows.length === 0 ? (
            <ConversationEmptyState message="No events yet" />
          ) : (
            <ThreadTimelineRows
              latestActivityRowId={latestActivityRowId}
              loadingToolGroupIds={loadingToolGroupIds}
              onLoadToolGroupMessages={onLoadToolGroupMessages}
              projectId={projectId}
              resolveUserAttachmentImageSrc={toUserAttachmentImageSrc}
              themeType={preferredTheme}
              threadDetailRows={threadDetailRows}
              threadStatus={threadStatus}
              toolGroupMessagesById={toolGroupMessagesById}
            />
          )}
        </ConversationTimeline>
        {showOngoingIndicator ? (
          <ConversationWorkingIndicator
            isThinking={isReasoningBlockActive}
            label={ongoingIndicatorLabel}
          />
        ) : null}
        <div
          ref={bottomSentinelRef}
          aria-hidden="true"
          data-thread-bottom-sentinel="true"
          className="h-px w-full shrink-0"
        />
      </PageShell>
    </div>
  );
}
