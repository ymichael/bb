/**
 * `@get-bb/plugin-sdk/provider-bridge` — the published authoring surface for a provider
 * bridge.
 *
 * A provider bridge ships inside its plugin's `bb.host` artifact, and a host
 * artifact may not import private `@bb/*` workspace packages: an external
 * plugin cannot resolve them. Everything a bridge needs therefore has to be
 * reachable through this package, which is why this module exists — it is the
 * bridge half of the same facade the root export already is for
 * `BbPluginApi`/`@bb/domain` types.
 *
 * Curated by hand, never `export *`. The list below is the surface bb promises
 * bridge authors; a name that is not here is bb-internal and may move. It is
 * grouped the way a bridge consumes it:
 *
 *   1. the bridge entry contract (how a module declares itself a bridge),
 *   2. the protocol — request/notification vocabulary, the `thread/delta`
 *      grammar, and param schemas,
 *   3. the bridge kit — the authoring helpers (JSON-RPC framing, tool-call and
 *      interaction codecs, visibility, dialect-parsing helpers),
 *   4. the domain vocabulary the protocol's payloads reference.
 *
 * On (4): the protocol owns its own timeline vocabulary (the delta grammar in
 * section 2) — bridges no longer construct `ThreadEvent`s, so the domain
 * event vocabulary is NOT re-exported here. What remains from `@bb/domain` is
 * the command-plane and interaction surface the protocol's params are made of
 * (PromptInput, permission/interaction payloads, dynamic tools, rate limits,
 * reasoning levels) plus the enum/status types the delta shapes reference
 * (item status, turn status, plan steps, usage breakdowns). Those live in
 * `@bb/domain` — bb's persisted vocabulary shared by the server, the app and
 * the runtime — so the SDK names them here and the published bundle inlines
 * them, exactly as the root export already does for `PromptInput` and
 * friends.
 *
 * Runtime, not stubs: unlike `@get-bb/plugin-sdk` and `@get-bb/plugin-sdk/host`
 * — whose host-artifact members are build-time stubs because their real
 * implementations belong to the server — everything here is pure schema and
 * pure helper code with no daemon-pinned behavior, so a bridge artifact simply
 * bundles it.
 */

// ---------------------------------------------------------------------------
// 1. The bridge entry contract
// ---------------------------------------------------------------------------

export {
  PROVIDER_BRIDGE_EXPORT_NAME,
  experimental_defineProviderBridge,
} from "@bb/provider-bridge-protocol/bridge-kit";
export type {
  ProviderBridgeContext,
  ProviderBridgeDefinition,
  ProviderBridgeEntry,
} from "@bb/provider-bridge-protocol/bridge-kit";

// ---------------------------------------------------------------------------
// 2. The Provider Bridge Protocol
// ---------------------------------------------------------------------------

export {
  BRIDGE_INBOUND_REQUEST_METHODS,
  BRIDGE_JSON_RPC_ERRORS,
  BRIDGE_NOTIFICATION_METHODS,
  BRIDGE_REQUEST_METHODS,
  PROVIDER_BRIDGE_PROTOCOL_VERSION,
  THREAD_DELTA_GRAMMAR_V2,
  THREAD_DELTA_GRAMMAR_V3,
  THREAD_DELTA_NOTIFICATION_METHOD,
  bridgeCapabilitiesSchema,
  bridgeGrammarVersionsSchema,
  bridgeSteerModeSchema,
  deltaBackgroundTaskShapeSchema,
  deltaDelegationShapeSchema,
  deltaExtensionShapeSchema,
  deltaFileChangeSchema,
  deltaFileReadShapeSchema,
  deltaItemKeySchema,
  deltaItemShapeSchema,
  deltaNoTurnFallbackSchema,
  deltaOutputChannelSchema,
  deltaPlanStepsShapeSchema,
  deltaPresentationSchema,
  deltaProgressSnapshotSchema,
  deltaSearchShapeSchema,
  deltaTextChannelSchema,
  providerRecoveryHintSchema,
  providerRecoveryNotificationSchema,
  bridgeErrorDataSchema,
  threadDeltaNotificationParamsSchema,
  threadDeltaSchema,
  initializeParamsSchema,
  modelListParamsSchema,
  providerHealthResultSchema,
  providerHealthSchema,
  providerInstallationActionKindSchema,
  providerInstallationActionSchema,
  providerInstallationCommandSchema,
  providerInstallationRunParamsSchema,
  providerInstallationStatusParamsSchema,
  providerInstallationRequirementSchema,
  providerInstallationRunResultSchema,
  providerInstallationSourceSchema,
  providerInstallationStatusSchema,
  providerInstallationVerificationSchema,
  providerMaintenanceParamsSchema,
  providerUsageResultSchema,
  providerUsageSchema,
  providerUsageWindowSchema,
  skillsConfigureParamsSchema,
  threadArchiveParamsSchema,
  threadDiscardParamsSchema,
  threadForkParamsSchema,
  threadGoalClearParamsSchema,
  threadNameSetParamsSchema,
  threadResumeParamsSchema,
  threadStartParamsSchema,
  threadStopParamsSchema,
  threadUnarchiveParamsSchema,
  turnStartParamsSchema,
  turnSteerParamsSchema,
} from "@bb/provider-bridge-protocol";
export type {
  BridgeCapabilities,
  BridgeExecutionOptions,
  BridgeGrammarVersions,
  BridgeSteerMode,
  DeltaBackgroundTaskShape,
  DeltaDelegationShape,
  DeltaExtensionShape,
  DeltaFileChange,
  DeltaFileReadShape,
  DeltaItemKey,
  DeltaItemShape,
  DeltaItemShapeType,
  DeltaNoTurnFallback,
  DeltaOutputChannel,
  DeltaPlanStepsShape,
  DeltaPresentation,
  DeltaProgressSnapshot,
  DeltaSearchShape,
  DeltaTextChannel,
  ProviderRecoveryHint,
  ProviderRecoveryNotification,
  BridgeErrorData,
  ProviderHealth,
  ProviderHealthResult,
  ProviderInstallationAction,
  ProviderInstallationActionKind,
  ProviderInstallationCommand,
  ProviderInstallationRunParams,
  ProviderInstallationRunResult,
  ProviderInstallationRequirement,
  ProviderInstallationSource,
  ProviderInstallationStatus,
  ProviderInstallationStatusParams,
  ProviderInstallationVerification,
  ProviderMaintenanceParams,
  ProviderUsage,
  ProviderUsageResult,
  ProviderUsageWindow,
  InitializeResult,
  ThreadDelta,
  ThreadDeltaKind,
  ThreadDeltaNotificationParams,
} from "@bb/provider-bridge-protocol";

// ---------------------------------------------------------------------------
// 3. The bridge kit
// ---------------------------------------------------------------------------

export {
  COMPACTION_PRESENTATION as experimental_COMPACTION_PRESENTATION,
  REASONING_PRESENTATION as experimental_REASONING_PRESENTATION,
  ZERO_TOKEN_USAGE,
  addTokenUsage,
  bashArgsSchema,
  BridgeRecoveryError as experimental_BridgeRecoveryError,
  clampPercent as experimental_clampPercent,
  commandOutput as experimental_commandOutput,
  compareVersions as experimental_compareVersions,
  bridgeRequestEnvelopeSchema,
  buildBridgeToolCallContent as experimental_buildBridgeToolCallContent,
  buildShellEnvOverrides,
  createBridgeIo,
  createBridgeLineHandler,
  createPendingToolCallTracker,
  createProviderVisibilityMetadata,
  decodeBridgeJsonRpcResponse,
  decodeToolCallResponsePayload,
  downloadedInstallerCommand as experimental_downloadedInstallerCommand,
  errorEnvelopeSchema,
  experimental_isProviderBridgeRecording,
  experimental_recordProviderChildIo,
  extractResultText,
  fileReadPresentation as experimental_fileReadPresentation,
  formatCommand as experimental_formatCommand,
  getRawSdkMessage,
  getRecordProperty,
  getStringProperty,
  installationVerification as experimental_installationVerification,
  isRecord,
  jsonRpcEnvelopeSchema,
  mimeTypeFromExtension,
  normalizeProviderCommandOutput,
  npmCommand as experimental_npmCommand,
  npmGlobalInstallCommand as experimental_npmGlobalInstallCommand,
  npmGlobalInstallSource as experimental_npmGlobalInstallSource,
  npmLatestVersion as experimental_npmLatestVersion,
  planStepsPresentation as experimental_planStepsPresentation,
  presentationDetail as experimental_presentationDetail,
  presentationFileName as experimental_presentationFileName,
  presentationTitle as experimental_presentationTitle,
  probeNpmGlobalPackage as experimental_probeNpmGlobalPackage,
  readBoundedLines as experimental_readBoundedLines,
  readCliVersion as experimental_readCliVersion,
  resolveExecutablePath as experimental_resolveExecutablePath,
  runBridgeRequest,
  sdkMessageEnvelopeSchema,
  searchPresentation as experimental_searchPresentation,
  shouldAutoDenyInteractiveRequest,
  textBlockSchema,
  threadContextWindowUsageEnvelopeSchema,
  threadIdentityEnvelopeSchema,
  toNonNegativeNumber,
  toOptionalRecord,
  toOptionalString,
  toolPresentation as experimental_toolPresentation,
  versionFrom as experimental_versionFrom,
  webFetchPresentation as experimental_webFetchPresentation,
  webSearchPresentation as experimental_webSearchPresentation,
  withTitle as experimental_withTitle,
  withoutBridgeRuntimeEnv,
  ProviderRequestDecodeError,
  ProviderResponseEncodeError,
} from "@bb/provider-bridge-protocol/bridge-kit";
export type {
  BoundedLineReaderArgs,
  BridgeJsonRpcResponse,
  NpmGlobalPackageProbe,
  BridgeSendError,
  BridgeToolCallRequest,
  BuildInteractiveResponseArgs,
  DecodedInteractiveRequest,
  JsonRpcMessage,
  PreparedProviderCommandDispatch,
  ProviderInboundRequest,
  ProviderPostInitializeRequest,
  ProviderRawEventCoverage,
  ProviderRawEventDescription,
  ProviderRuntimeEvent,
  ProviderVisibilityMetadata,
} from "@bb/provider-bridge-protocol/bridge-kit";

/**
 * Removes inherited `NODE_ENV` and `BB_*` names while preserving every other
 * defined value; callers may overlay child-specific bb variables afterward.
 */
export { sanitizeInheritedChildProcessEnv } from "@bb/process-utils";

// ---------------------------------------------------------------------------
// 4. The domain vocabulary the protocol's payloads reference
// ---------------------------------------------------------------------------

export {
  HIGH_REASONING_EFFORT,
  LOCAL_BASH_TASK_TYPE,
  LOCAL_WORKFLOW_TASK_TYPE,
  LOW_REASONING_EFFORT,
  MAX_REASONING_EFFORT,
  MEDIUM_REASONING_EFFORT,
  ULTRACODE_REASONING_EFFORT,
  USER_QUESTION_MAX_OPTIONS,
  USER_QUESTION_MAX_QUESTIONS,
  XHIGH_REASONING_EFFORT,
  acpNativeReasoningSchema,
  acpPermissionCliSchema,
  acpReasoningCliSchema,
  backgroundTaskItemStatus,
  dynamicToolSchema,
  instructionModeValues,
  approvalInteractionOutcomeSchema,
  isApprovalInteractionOutcome,
  isApprovalPendingInteractionPayload,
  isApprovalPendingInteractionResolution,
  isBackgroundAgentTaskType,
  isSettledBackgroundTaskStatus,
  isStandaloneBuiltinCompactCommand,
  isUserQuestionPendingInteractionPayload,
  isUserQuestionPendingInteractionResolution,
  jsonValueSchema,
  pendingInteractionCommandActionSchema,
  pendingInteractionFileSystemPermissionsSchema,
  pendingInteractionMacOsPermissionsSchema,
  pendingInteractionNetworkPermissionsSchema,
  pendingInteractionRequestedPermissionProfileSchema,
  pendingInteractionResolutionSchema,
  providerInteractionOutcomeSchema,
  userQuestionInteractionOutcomeSchema,
  permissionEscalationValues,
  extensionKindSchema,
  interactionRequestPayloadSchema,
  isExtensionKind,
  providerRawEventSchema,
  providerRecoveryKindSchema,
  providerRecoveryKindValues,
  threadEventItemPresentationSchema,
  threadEventSearchModeSchema,
  reasoningEffortsForLevels,
  reasoningLevelSchema,
  reasoningLevelValues,
  removeCommandMentionsFromPromptInput,
  runtimePermissionScopeValues,
  toPositiveNumber,
} from "@bb/domain";
export type {
  ApprovalInteractionOutcome,
  ApprovalPendingInteractionPayload,
  AvailableModel,
  BackgroundTaskStatus,
  BackgroundTaskUsage,
  ClientTurnRequestId,
  DynamicTool,
  ExtensionKind,
  InstructionMode,
  InteractionRequestPayload,
  ProviderInteractionOutcome,
  UserQuestionInteractionOutcome,
  JsonObject,
  JsonValue,
  ModelReasoningEffort,
  PendingInteractionApprovalDecision,
  PendingInteractionApprovalSubject,
  PendingInteractionCommandAction,
  PendingInteractionGrantablePermissionProfile,
  PendingInteractionGrantedPermissionProfile,
  PendingInteractionPayload,
  PendingInteractionRequestedPermissionProfile,
  PendingInteractionResolution,
  PendingInteractionUserQuestionQuestion,
  PermissionEscalation,
  PermissionMode,
  PromptInput,
  ProviderErrorCategory,
  ProviderErrorInfo,
  ProviderRawEvent,
  ProviderRateLimitState,
  ProviderRateLimitStatus,
  ProviderRateLimitWindow,
  ProviderRecoveryKind,
  ReasoningLevel,
  RuntimePermissionPolicy,
  RuntimePermissionScope,
  ServiceTier,
  ThreadEventContextWindowUsage,
  ThreadEventItemPresentation,
  ThreadEventItemStatus,
  ThreadEventPlanStep,
  ThreadEventSearchMode,
  ThreadEventTokenUsageBreakdown,
  ThreadEventTurnStatus,
  ThreadEventUserContent,
  UserQuestionPendingInteractionPayload,
  UserQuestionPendingInteractionResolution,
  WorkflowAgentSnapshot,
  WorkflowAgentState,
  WorkflowPhaseSnapshot,
  WorkflowProgressSnapshot,
} from "@bb/domain";

// ---------------------------------------------------------------------------
// 5. Scheduled removals (next major)
// ---------------------------------------------------------------------------
//
// Names 0.4.x published on this subpath that no longer have a consumer in
// this repository. Each stays an alias of its current definition until the
// next major version: a bridge compiled against an earlier SDK may import it,
// and dropping a published name is a breaking change (docs/api_to_audit.md,
// "Scheduled removals"). The unprefixed domain re-exports listed there sit in
// section 4 with their neighbours; these are the ones whose definition moved.

/**
 * The ACP launch spec and its normalizer, once a host-daemon wire shape. The
 * schema now lives with the ACP bridge kit — a plugin that declares an ACP
 * agent reads `experimental_acpLaunchSpecSchema` / `AcpLaunchSpec` from
 * `@get-bb/plugin-sdk/provider-bridge/acp` instead.
 */
export {
  acpLaunchSpecSchema as hostDaemonAcpLaunchSpecSchema,
  normalizeAcpLaunchSpec as normalizeHostDaemonAcpLaunchSpec,
} from "@bb/provider-bridge-acp/launch-spec";
export type { AcpLaunchSpec as HostDaemonAcpLaunchSpec } from "@bb/provider-bridge-acp/launch-spec";

/**
 * The Claude Code task-tool names and outputs core once shared with the
 * claude-code runtime. The claude-code plugin owns its own vocabulary now;
 * there is no replacement.
 */
export {
  claudeTaskToolNameSchema,
  claudeTaskToolOutputSchema,
} from "./claude-task-tools.js";
export type { ClaudeTaskToolOutput } from "./claude-task-tools.js";
