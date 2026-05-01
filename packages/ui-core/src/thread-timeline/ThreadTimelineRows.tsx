import type {
  ThreadRuntimeDisplayStatus,
} from "@bb/domain";
import type { TimelineRow, TimelineTurnRow } from "@bb/server-contract";
import type {
  ThreadTimelineLocalFileLinkHandler,
  ThreadTimelineTheme,
  UserAttachmentImageSrcResolver,
} from "./types.js";

export interface ThreadTimelineRowsProps {
  erroredTurnSummaryIds: ReadonlySet<string>;
  loadingTurnSummaryIds: ReadonlySet<string>;
  onLoadTurnSummaryRows: (entry: TimelineTurnRow) => void;
  onOpenLocalFileLink?: ThreadTimelineLocalFileLinkHandler;
  projectId?: string;
  resolveUserAttachmentImageSrc?: UserAttachmentImageSrcResolver;
  themeType?: ThreadTimelineTheme;
  timelineRows: TimelineRow[];
  threadRuntimeDisplayStatus: ThreadRuntimeDisplayStatus;
  turnSummaryRowsById: Record<string, TimelineRow[]>;
}

export function ThreadTimelineRows(_props: ThreadTimelineRowsProps) {
  return null;
}
