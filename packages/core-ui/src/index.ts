export { assertNever } from "./assert-never.js";

export {
  formatEnvironmentDisplay,
  resolveEnvironmentDisplayName,
  resolveEnvironmentDisplayProvider,
  resolveEnvironmentProviderLabel,
} from "./environment-display.js";
export type {
  EnvironmentDisplayHostContext,
  EnvironmentDisplayInfo,
  EnvironmentDisplayNameSource,
  EnvironmentDisplayProvider,
  EnvironmentDisplayProviderLookup,
} from "./environment-display.js";

export {
  buildPendingInteractionApprovalResolution,
  formatPendingInteractionApprovalResolutionOutcome,
  formatPendingInteractionSubjectDetailLines,
  summarizePendingInteractionRequestedPermissions,
} from "./pending-interaction-formatting.js";
export {
  formatPendingInteractionSummary,
  formatPendingInteractionUserQuestionOptionLabel,
} from "./pending-interaction-presentation.js";
export {
  describePendingInteractionToolUse,
  formatPendingInteractionToolUseDetailLines,
} from "./pending-interaction-tool-use.js";
export type {
  PendingInteractionToolUseAsk,
  ToolUseApprovalPendingInteractionPayload,
} from "./pending-interaction-tool-use.js";

export { extractErrorMessage, toRecord } from "./unknown-helpers.js";
