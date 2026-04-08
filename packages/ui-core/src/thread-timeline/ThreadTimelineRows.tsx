import { buildToolGroupSummaryParts } from "@bb/core-ui";
import type { TimelineRow, TimelineToolGroupRow, ViewMessage } from "@bb/domain";
import { ExpandablePanel } from "../disclosure.js";
import { ConversationEntry } from "./ConversationEntry.js";
import { useLatestInitialExpanded } from "./latestInitialExpanded.js";
import { shouldPreferOngoingLabelsForRow } from "./threadDetailActivity.js";
import type {
  ThreadTimelineTheme,
  UserAttachmentImageSrcResolver,
} from "./types.js";
import {
  EventTitle,
  type EventTitleTone,
  formatSummaryDuration,
  getEventHeaderToneClass,
} from "./rows/shared.js";

interface ToolGroupEntryProps {
  entry: TimelineToolGroupRow;
  initialExpanded: boolean;
  isLoadingMessages: boolean;
  messages: TimelineToolGroupRow["messages"];
  onLoadMessages: () => void;
  preferOngoingLabels: boolean;
  projectId?: string;
  resolveUserAttachmentImageSrc?: UserAttachmentImageSrcResolver;
  themeType?: ThreadTimelineTheme;
}

interface ThreadTimelineRowsProps {
  latestActivityRowId: string | null;
  loadingToolGroupIds: ReadonlySet<string>;
  onLoadToolGroupMessages: (entry: TimelineToolGroupRow) => void;
  projectId?: string;
  resolveUserAttachmentImageSrc?: UserAttachmentImageSrcResolver;
  themeType?: ThreadTimelineTheme;
  threadDetailRows: TimelineRow[];
  threadStatus: string;
  toolGroupMessagesById: Record<string, ViewMessage[]>;
}

function ToolGroupEntry({
  entry,
  initialExpanded,
  isLoadingMessages,
  messages,
  onLoadMessages,
  preferOngoingLabels,
  projectId,
  resolveUserAttachmentImageSrc,
  themeType,
}: ToolGroupEntryProps) {
  const { isExpanded, onToggle } = useLatestInitialExpanded(initialExpanded);
  const visibleDuration = formatSummaryDuration(entry.durationMs);
  const isWorking = entry.status === "pending";
  const tone: EventTitleTone = "default";
  const summary = buildToolGroupSummaryParts({
    duration: visibleDuration,
    status: entry.status,
    summaryCount: entry.summaryCount,
  });
  const summaryContent = (
    <EventTitle
      prefix={summary.prefix}
      emphasis={summary.emphasis}
      suffix={summary.suffix}
      suffixClassName="truncate"
      shimmerPrefix={isWorking}
      tone={tone}
    />
  );
  const headerToneClass = getEventHeaderToneClass(isExpanded, tone);

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
              const isSingleItem = messages.length === 1;
              return (
                <ConversationEntry
                  key={message.id}
                  message={message}
                  projectId={projectId}
                  initialExpanded={isSingleItem || (initialExpanded && isLatestMessage)}
                  preferOngoingLabels={preferOngoingLabels && isLatestMessage}
                  resolveUserAttachmentImageSrc={resolveUserAttachmentImageSrc}
                  themeType={themeType}
                />
              );
            })}
          </div>
        </ExpandablePanel>
      </div>
    </div>
  );
}

export function ThreadTimelineRows({
  latestActivityRowId,
  loadingToolGroupIds,
  onLoadToolGroupMessages,
  projectId,
  resolveUserAttachmentImageSrc,
  themeType,
  threadDetailRows,
  threadStatus,
  toolGroupMessagesById,
}: ThreadTimelineRowsProps) {
  return (
    <>
      {threadDetailRows.map((entry, entryIndex) => {
        const isLastRow = entryIndex === threadDetailRows.length - 1;
        const isProvisioningOrActive =
          threadStatus === "active" || threadStatus === "provisioning";
        const preferOngoingLabels =
          isProvisioningOrActive &&
          isLastRow &&
          shouldPreferOngoingLabelsForRow(entry, latestActivityRowId);
        const isLastError =
          isLastRow &&
          threadStatus === "error" &&
          entry.kind === "message" &&
          entry.message.kind === "error";
        const shouldAutoExpand =
          (isLastRow && isProvisioningOrActive) || isLastError;

        return (
          <div key={entry.id} data-thread-row-id={entry.id} className="pt-2">
            {entry.kind === "tool-group" ? (
              <ToolGroupEntry
                entry={entry}
                messages={toolGroupMessagesById[entry.id] ?? entry.messages}
                isLoadingMessages={loadingToolGroupIds.has(entry.id)}
                onLoadMessages={() => onLoadToolGroupMessages(entry)}
                initialExpanded={shouldAutoExpand}
                preferOngoingLabels={preferOngoingLabels}
                projectId={projectId}
                resolveUserAttachmentImageSrc={resolveUserAttachmentImageSrc}
                themeType={themeType}
              />
            ) : (
              <ConversationEntry
                message={entry.message}
                projectId={projectId}
                initialExpanded={shouldAutoExpand}
                preferOngoingLabels={preferOngoingLabels}
                resolveUserAttachmentImageSrc={resolveUserAttachmentImageSrc}
                themeType={themeType}
              />
            )}
          </div>
        );
      })}
    </>
  );
}
