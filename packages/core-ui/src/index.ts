export { assertNever } from "./assert-never.js";

export { formatEnvironmentDisplay } from "./environment-display.js";
export type { EnvironmentDisplayInfo } from "./environment-display.js";

export {
  buildPendingInteractionApprovalResolution,
  formatPendingInteractionApprovalResolutionOutcome,
  formatPendingInteractionCommandApprovalResolutionMessage,
  formatPendingInteractionFileChangeApprovalResolutionMessage,
  formatPendingInteractionPermissionResolutionMessage,
  formatPendingInteractionPermissionResolutionOutcome,
  formatPendingInteractionSubjectDetailLines,
  getPendingInteractionApprovalGrantedPermissions,
  isPendingInteractionCommandApprovalPositiveDecision,
  summarizePendingInteractionCommandActions,
  summarizePendingInteractionRequestedMacOsPermissions,
  summarizePendingInteractionRequestedPermissions,
  toGrantedPendingInteractionPermissions,
} from "./pending-interaction-formatting.js";
export { formatPendingInteractionSummary } from "./pending-interaction-presentation.js";
export type {
  FormatPendingInteractionSummaryArgs,
  PendingInteractionPresentationSurface,
} from "./pending-interaction-presentation.js";

export { formatTimelineAsText } from "./format-timeline-text.js";
export type {
  FormatTimelineOptions,
  TimelineTextFormatOptions,
  TimelineFormat,
} from "./format-timeline-text.js";
export { durationToCompactString, timeAgo } from "./format-helpers.js";
export {
  buildTimelineAssistantStepSummary,
  buildTimelineAssistantStepSummaryLabel,
  formatTimelineAssistantStepSummary,
} from "./timeline-assistant-step-summary.js";
export type {
  TimelineAssistantStepSummary,
} from "./timeline-assistant-step-summary.js";
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
  summarizeExploringCounts,
} from "./timeline-render-helpers.js";
export type { ExploringCounts } from "./timeline-render-helpers.js";
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
  isShellToolName,
} from "./tool-call-parsing.js";

export { taskStatusGlyph } from "./task-status.js";

export {
  deriveThreadTitleFromInput,
  outputFromThreadEvent,
} from "./provider-event-utils.js";

export { extractThreadContextWindowUsage } from "./thread-context-window-usage.js";
export { extractActiveThinking } from "./active-thinking.js";

export {
  buildCollapsedTimelineRows,
  buildTimelineRows,
} from "./thread-detail-rows.js";
export type { BuildTimelineRowsOptions } from "./thread-detail-rows.js";
export {
  flattenProjectionMessages,
  flattenProjectionMessagesDeep,
  flattenViewMessagesDeep,
} from "./projection-flatten.js";

export { decodeRow } from "./event-decode.js";
export type { EventMeta } from "./event-decode.js";

export { toViewMessages, toViewProjection } from "./to-view-messages.js";
export type { ThreadEventWithMeta } from "./to-view-messages.js";

export { extractErrorMessage, toRecord } from "./unknown-helpers.js";
