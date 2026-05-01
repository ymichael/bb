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

export { durationToCompactString, timeAgo } from "./format-helpers.js";

export { extractErrorMessage, toRecord } from "./unknown-helpers.js";
