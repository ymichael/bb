export { assertNever } from "./assert-never.js";

export { formatTimelineAsText } from "./format-timeline-text.js";
export type {
  FormatTimelineOptions,
  TimelineTextFormatOptions,
  TimelineFormat,
} from "./format-timeline-text.js";
export { getThreadTimelineRowTitle } from "./thread-timeline-row-title.js";
export type {
  ThreadTimelineRichTitle,
  ThreadTimelineRowTitle,
  ThreadTimelineTitleContext,
} from "./thread-timeline-row-title.js";
export { durationToCompactString, timeAgo } from "./format-helpers.js";
export {
  fileChangeIdentity,
  fileNameFromPath,
  summarizeChangedFileNames,
} from "./file-change-summary.js";
export {
  buildToolBundleDetailLines,
} from "./timeline-tool-bundle-summary.js";
export {
  buildTimelineRowActivityInfoMap,
  findLatestActivityMessageId,
  findLatestActivityRowId,
  shouldHighlightLatestActivity,
  shouldPreferOngoingLabelsForRow,
} from "./thread-detail-activity.js";
export type { TimelineRowActivityInfo } from "./thread-detail-activity.js";
export {
  isIgnoredNoiseType,
  TIMELINE_NOISE_EVENT_TYPES,
} from "./timeline-noise-events.js";
export {
  buildExploringDetailLines,
  formatExploringIntentLine,
  summarizeExploringCounts,
} from "./timeline-render-helpers.js";
export type {
  ToolIntentSummary,
} from "./timeline-render-helpers.js";
export {
  formatCommandOutputText,
  getTimelineDisplayStatus,
} from "./timeline-display-status.js";

export {
  extractShellCommandFromString,
} from "./tool-call-parsing.js";

export { taskStatusGlyph } from "./task-status.js";

export {
  deriveThreadTitleFromInput,
  outputFromThreadEvent,
} from "./provider-event-utils.js";

export { extractThreadContextWindowUsage } from "./thread-context-window-usage.js";

export {
  buildCollapsedGroupedTimelineRows,
  buildGroupedTimelineRows,
} from "./timeline-grouping.js";
export type { GroupedTimelineRowsOptions } from "./timeline-grouping.js";
export {
  flattenProjectionMessages,
  flattenProjectionMessagesDeep,
  flattenViewMessagesDeep,
} from "./projection-flatten.js";

export { decodeRow } from "./event-decode.js";
export type { EventMeta } from "./event-decode.js";

export {
  toViewMessages,
  toViewProjection,
  toViewProjectionEntries,
} from "./to-view-messages.js";
export type { ThreadEventWithMeta } from "./to-view-messages.js";
