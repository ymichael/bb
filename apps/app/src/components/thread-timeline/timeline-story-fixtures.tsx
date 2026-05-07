import type { ReactNode } from "react";
import type { ThreadRuntimeDisplayStatus } from "@bb/domain";
import type { TimelineRow } from "@bb/server-contract";
import { ThreadTimelineRows, type TimelineTitleActionResolver } from "./index";
import { ConversationTimeline } from "../ui";
import type {
  ThreadTimelineLocalFileLinkHandler,
  UserAttachmentImageSrcResolver,
} from "./types";

export interface TimelineRowsStoryProps {
  autoExpand?: boolean;
  className?: string;
  erroredTurnSummaryIds?: ReadonlySet<string>;
  loadingTurnSummaryIds?: ReadonlySet<string>;
  onOpenLocalFileLink?: ThreadTimelineLocalFileLinkHandler;
  projectId?: string;
  resolveUserAttachmentImageSrc?: UserAttachmentImageSrcResolver;
  rows: TimelineRow[];
  threadRuntimeDisplayStatus?: ThreadRuntimeDisplayStatus;
  turnSummaryRowsIdentity?: string;
  turnSummaryRowsById?: Record<string, TimelineRow[]>;
}

export interface TimelineStoryCase extends TimelineRowsStoryProps {
  id: string;
  title: string;
}

export interface TimelineCaseGridProps {
  cases: readonly TimelineStoryCase[];
}

export interface TimelineStoryShellProps {
  children: ReactNode;
}

interface TimelineStoryCardProps {
  storyCase: TimelineStoryCase;
}

const EMPTY_ROW_ID_SET: ReadonlySet<string> = new Set<string>();
const EMPTY_TURN_SUMMARY_ROWS_BY_ID: Record<string, TimelineRow[]> = {};

const storyTitleActionResolver: TimelineTitleActionResolver = () => {
  return () => undefined;
};

export function TimelineRowsStory({
  autoExpand = false,
  className,
  erroredTurnSummaryIds = EMPTY_ROW_ID_SET,
  loadingTurnSummaryIds = EMPTY_ROW_ID_SET,
  onOpenLocalFileLink,
  projectId,
  resolveUserAttachmentImageSrc,
  rows,
  threadRuntimeDisplayStatus = "idle",
  turnSummaryRowsIdentity = "story",
  turnSummaryRowsById = EMPTY_TURN_SUMMARY_ROWS_BY_ID,
}: TimelineRowsStoryProps) {
  return (
    <div className={className}>
      <ConversationTimeline>
        <ThreadTimelineRows
          defaultExpandAllRows={autoExpand}
          loadingTurnSummaryIds={loadingTurnSummaryIds}
          erroredTurnSummaryIds={erroredTurnSummaryIds}
          onLoadTurnSummaryRows={() => undefined}
          onOpenLocalFileLink={onOpenLocalFileLink}
          onTitleAction={storyTitleActionResolver}
          projectId={projectId}
          resolveUserAttachmentImageSrc={resolveUserAttachmentImageSrc}
          timelineRows={rows}
          threadRuntimeDisplayStatus={threadRuntimeDisplayStatus}
          turnSummaryRowsIdentity={turnSummaryRowsIdentity}
          turnSummaryRowsById={turnSummaryRowsById}
        />
      </ConversationTimeline>
    </div>
  );
}

function TimelineStoryCard({ storyCase }: TimelineStoryCardProps) {
  const { title, ...timelineProps } = storyCase;
  return (
    <section className="rounded-md border border-border/70 bg-background p-3">
      <div className="mb-2 truncate text-xs font-medium text-muted-foreground">
        {title}
      </div>
      <TimelineRowsStory {...timelineProps} />
    </section>
  );
}

export function TimelineCaseGrid({ cases }: TimelineCaseGridProps) {
  return (
    <div className="min-h-screen bg-background p-6 text-foreground">
      <div className="mx-auto grid max-w-6xl grid-cols-1 gap-4 lg:grid-cols-2">
        {cases.map((storyCase) => (
          <TimelineStoryCard key={storyCase.id} storyCase={storyCase} />
        ))}
      </div>
    </div>
  );
}

export function TimelineStoryShell({ children }: TimelineStoryShellProps) {
  return (
    <div className="min-h-screen bg-background p-6 text-foreground">
      <div className="mx-auto max-w-3xl rounded-md border border-border/70 bg-background p-4">
        {children}
      </div>
    </div>
  );
}
