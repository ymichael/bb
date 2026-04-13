export { assertNever } from "./assert-never.js";

export { formatEnvironmentDisplay } from "./environment-display.js";
export type { EnvironmentDisplayInfo } from "./environment-display.js";

export {
  formatPendingInteractionCommandApprovalDecision,
  formatPendingInteractionCommandApprovalResolutionMessage,
  formatPendingInteractionCommandApprovalResolutionOutcome,
  formatPendingInteractionFileChangeApprovalResolutionMessage,
  formatPendingInteractionFileChangeApprovalResolutionOutcome,
  formatPendingInteractionPermissionResolutionMessage,
  formatPendingInteractionPermissionResolutionOutcome,
  getPendingInteractionCommandApprovalDecisionKind,
  isPendingInteractionCommandApprovalPositiveDecision,
  summarizePendingInteractionRequestedMacOsPermissions,
  summarizePendingInteractionRequestedPermissions,
  toGrantedPendingInteractionPermissions,
} from "./pending-interaction-formatting.js";
export type {
  PendingInteractionCommandApprovalDecisionKind,
  PendingInteractionPermissionResolutionSummaryArgs,
} from "./pending-interaction-formatting.js";
export {
  formatPendingInteractionKindLabel,
  formatPendingInteractionSummary,
} from "./pending-interaction-presentation.js";
export type {
  FormatPendingInteractionKindLabelArgs,
  FormatPendingInteractionSummaryArgs,
  PendingInteractionPresentationSurface,
} from "./pending-interaction-presentation.js";

export { formatTimelineAsText } from "./format-timeline-text.js";
export type {
  FormatTimelineOptions,
  TimelineFormat,
} from "./format-timeline-text.js";
export { durationToCompactString, timeAgo } from "./format-helpers.js";
export {
  buildToolGroupSummaryParts,
  formatToolGroupCountLabel,
} from "./timeline-summary.js";
export type { ToolGroupSummaryParts } from "./timeline-summary.js";
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

export { extractShellCommandFromString } from "./tool-call-parsing.js";

export { taskStatusGlyph } from "./task-status.js";

export {
  deriveThreadTitleFromInput,
  outputFromThreadEvent,
} from "./provider-event-utils.js";

export { extractThreadContextWindowUsage } from "./thread-context-window-usage.js";

export {
  buildTimelineRows,
  buildTimelineRowsFromMessagesForNestedDisplay,
} from "./thread-detail-rows.js";
export type {
  BuildTimelineRowsOptions,
} from "./thread-detail-rows.js";

export { decodeRow } from "./event-decode.js";
export type { EventMeta } from "./event-decode.js";

export { toViewMessages, toViewProjection } from "./to-view-messages.js";
export type { ThreadEventWithMeta } from "./to-view-messages.js";

export {
  extractErrorMessage,
  toRecord,
} from "./unknown-helpers.js";
