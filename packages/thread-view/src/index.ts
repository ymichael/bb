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
  buildTimelineAssistantStepSummary,
  buildTimelineAssistantStepSummaryLabel,
  formatTimelineAssistantStepSummary,
} from "./timeline-assistant-step-summary.js";
export type { TimelineAssistantStepSummary } from "./timeline-assistant-step-summary.js";
export {
  countUniqueChangedFiles,
  fileChangeIdentity,
  fileNameFromPath,
  formatFileChangeName,
  summarizeChangedFileNames,
} from "./file-change-summary.js";
export type { ChangedFileNamesSummary } from "./file-change-summary.js";
export {
  buildToolBundleDetailLines,
  buildToolBundleSummaryLabel,
  buildToolBundleSummaryParts,
  formatToolBundleSummaryLabel,
} from "./timeline-tool-bundle-summary.js";
export type { ToolBundleSummaryParts } from "./timeline-tool-bundle-summary.js";
export {
  buildTurnSummaryParts,
  formatTurnSummaryCountLabel,
} from "./timeline-turn-summary.js";
export type { TurnSummaryParts } from "./timeline-turn-summary.js";
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
  formatDelegationSummary,
  formatExploringCountsLabel,
  formatExploringIntentLine,
  getDelegationSummaryParts,
  summarizeExploringCounts,
} from "./timeline-render-helpers.js";
export type {
  DelegationSummaryParts,
  ExploringCounts,
  ToolIntentSummary,
} from "./timeline-render-helpers.js";
export {
  formatCommandOutputText,
  getCommandExitCodeLine,
  getPermissionGrantDisplayStatus,
  getTimelineDisplayStatus,
  getTimelineDisplayStatusInfo,
  getVisibleCommandOutput,
  hasVisibleCommandOutput,
  timelineDisplayStatusValues,
} from "./timeline-display-status.js";
export type {
  TimelineDisplayStatus,
  TimelineDisplayStatusInfo,
  TimelineDisplayStatusTone,
} from "./timeline-display-status.js";

export {
  extractShellCommandFromString,
  formatToolCallCommand,
  isShellToolName,
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
