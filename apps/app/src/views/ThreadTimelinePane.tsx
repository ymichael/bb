import { type ReactNode, type RefObject } from "react";
import { type ThreadDetailRow, type UIMessage } from "@beanbag/agent-core";
import {
  ConversationEmptyState,
  ConversationTimeline,
  ExpandablePanel,
} from "@beanbag/ui-core";
import { PageShell } from "@/components/layout/PageShell";
import { ConversationEntry } from "@/components/messages/ConversationEntry";
import { ConversationWorkingIndicator } from "@/components/messages/ConversationWorkingIndicator";
import {
  EventTitle,
  formatSummaryDuration,
  getEventHeaderToneClass,
} from "@/components/messages/rows/shared";
import { useLatestInitialExpanded } from "@/lib/latestInitialExpanded";
import { shouldPreferOngoingLabelsForRow } from "./threadDetailActivity";
import { type ThreadDetailToolGroupRow } from "./threadDetailRows";

function ToolGroupEntry({
  projectId,
  entry,
  messages,
  isLoadingMessages,
  onLoadMessages,
  initialExpanded,
  preferOngoingLabels,
}: {
  projectId?: string;
  entry: ThreadDetailToolGroupRow;
  messages: ThreadDetailToolGroupRow["messages"];
  isLoadingMessages: boolean;
  onLoadMessages: () => void;
  initialExpanded: boolean;
  preferOngoingLabels: boolean;
}) {
  const { isExpanded, onToggle } = useLatestInitialExpanded(initialExpanded);
  const count = entry.summaryCount;
  const visibleDuration = formatSummaryDuration(entry.durationMs);
  const isWorking = entry.status === "pending";
  const summaryContent = visibleDuration ? (
    <EventTitle
      prefix={isWorking ? "Working for" : "Worked for"}
      emphasis={visibleDuration}
      suffix={count > 0 ? `${count} item${count === 1 ? "" : "s"}` : undefined}
      suffixClassName="truncate"
      shimmerPrefix={isWorking}
    />
  ) : (
    <EventTitle
      prefix={isWorking ? "Working on" : "Worked on"}
      emphasis={`${count} item${count === 1 ? "" : "s"}`}
      shimmerPrefix={isWorking}
    />
  );
  const headerToneClass = getEventHeaderToneClass(isExpanded);

  const handleToggle = () => {
    if (!isExpanded && messages.length === 0 && !isLoadingMessages) {
      onLoadMessages();
    }
    onToggle();
  };

  return (
    <div className="group w-full" style={{ overflowAnchor: "none" }}>
      <div className="mr-auto w-full">
        <ExpandablePanel
          isExpanded={isExpanded}
          onToggle={handleToggle}
          headerToneClass={headerToneClass}
          summaryContent={summaryContent}
          bodyClassName="duration-300"
          contentClassName="pb-1 duration-300"
        >
          <div className="overflow-hidden rounded-md border border-border/60 bg-background/40">
            {isLoadingMessages ? (
              <div className="px-3 py-2 text-xs text-muted-foreground">
                <span className="animate-shine">Loading details...</span>
              </div>
            ) : null}
            {messages.map((message, messageIndex) => {
              const isLatestMessage = messageIndex === messages.length - 1;
              return (
                <ConversationEntry
                  key={message.id}
                  message={message}
                  projectId={projectId}
                  initialExpanded={initialExpanded && isLatestMessage}
                  preferOngoingLabels={preferOngoingLabels && isLatestMessage}
                />
              );
            })}
          </div>
        </ExpandablePanel>
      </div>
    </div>
  );
}

interface ThreadTimelinePaneProps {
  bottomSentinelRef: RefObject<HTMLDivElement | null>;
  footer: ReactNode;
  header: ReactNode;
  isReasoningBlockActive: boolean;
  isThreadTimelinePending: boolean;
  isTransientThreadLoadError: boolean;
  latestActivityRowId: string | null;
  loadingToolGroupIds: ReadonlySet<string>;
  onLoadToolGroupMessages: (entry: ThreadDetailToolGroupRow) => void;
  onScroll: () => void;
  projectId?: string;
  scrollRef: (element: HTMLDivElement | null) => void;
  showOngoingIndicator: boolean;
  threadDetailRows: ThreadDetailRow[];
  threadId: string;
  threadStatus: string;
  toolGroupMessagesById: Record<string, UIMessage[]>;
}

export function ThreadTimelinePane({
  bottomSentinelRef,
  footer,
  header,
  isReasoningBlockActive,
  isThreadTimelinePending,
  isTransientThreadLoadError,
  latestActivityRowId,
  loadingToolGroupIds,
  onLoadToolGroupMessages,
  onScroll,
  projectId,
  scrollRef,
  showOngoingIndicator,
  threadDetailRows,
  threadId,
  threadStatus,
  toolGroupMessagesById,
}: ThreadTimelinePaneProps) {
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
        {isTransientThreadLoadError ? (
          <div className="mb-2 rounded-md border border-border/80 bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
            Daemon temporarily unavailable. Showing cached thread state while reconnecting.
          </div>
        ) : null}
        <ConversationTimeline>
          {isThreadTimelinePending ? (
            <ConversationWorkingIndicator
              label="Loading thread..."
              className="mt-6"
            />
          ) : threadDetailRows.length === 0 ? (
            <ConversationEmptyState message="No events yet" />
          ) : (
            threadDetailRows.map((entry, entryIndex) => {
              const isLastRow = entryIndex === threadDetailRows.length - 1;
              const preferOngoingLabels =
                threadStatus === "active" &&
                isLastRow &&
                shouldPreferOngoingLabelsForRow(entry, latestActivityRowId);
              return (
                <div
                  key={`${threadId}:${entry.id}`}
                  data-thread-row-id={entry.id}
                  className="pt-2"
                >
                  {entry.kind === "tool-group" ? (
                    <ToolGroupEntry
                      projectId={projectId}
                      entry={entry}
                      messages={toolGroupMessagesById[entry.id] ?? entry.messages}
                      isLoadingMessages={loadingToolGroupIds.has(entry.id)}
                      onLoadMessages={() => onLoadToolGroupMessages(entry)}
                      initialExpanded={isLastRow}
                      preferOngoingLabels={preferOngoingLabels}
                    />
                  ) : (
                    <ConversationEntry
                      message={entry.message}
                      projectId={projectId}
                      initialExpanded={isLastRow}
                      preferOngoingLabels={preferOngoingLabels}
                    />
                  )}
                </div>
              );
            })
          )}
        </ConversationTimeline>
        {showOngoingIndicator ? (
          <ConversationWorkingIndicator isThinking={isReasoningBlockActive} />
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
