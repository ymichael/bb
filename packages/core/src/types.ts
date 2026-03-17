import type {
  CodexServerNotificationMethod,
  CodexServerNotificationParamsByMethod,
} from "./generated/codex-app-server/index.js";
import type {
  PromptInput,
  ReasoningLevel,
  SandboxMode,
  ServiceTier,
} from "./shared-types.js";
import type { ThreadExecutionOptions } from "./api-types.js";

// Project
export interface Project {
  id: string;
  name: string;
  rootPath: string;
  projectInstructions?: string;
  defaultProviderId?: string;
  primaryCheckoutThreadId?: string;
  primaryManagerThreadId?: string;
  rootPathExists?: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface EnvironmentDescriptor {
  type: "path";
  path: string;
}

export type EnvironmentLocation = "localhost" | "docker" | "remote";

export type EnvironmentWorkspaceKind =
  | "primary_checkout"
  | "worktree"
  | "arbitrary_path";

export interface EnvironmentProperties {
  provisioningSystemKind: string;
  location: EnvironmentLocation;
  workspaceKind: EnvironmentWorkspaceKind;
}

export interface EnvironmentRecord {
  id: string;
  projectId: string;
  descriptor?: EnvironmentDescriptor;
  managed: boolean;
  properties?: EnvironmentProperties;
  runtimeState?: PersistedEnvironmentRecord;
  createdAt: number;
  updatedAt: number;
}

// Thread
export type EnvironmentCapability =
  | "host_filesystem"
  | "isolated_workspace"
  | "promote_primary_checkout"
  | "demote_primary_checkout"
  | "squash_merge";

export type EnvironmentCapabilities = Record<EnvironmentCapability, boolean>;

export type ThreadBuiltInActionId =
  | "commit"
  | "squash_merge"
  | "promote"
  | "demote";

export interface ThreadBuiltInAction {
  id: ThreadBuiltInActionId;
  label: string;
  available: boolean;
  disabledReason?: string;
  queuesWhenActive: boolean;
  requiresDemoteFirst: boolean;
}

export type ThreadPendingOperationType = "commit" | "squash_merge";

export type ThreadPendingOperationStatus = "queued" | "running";

export interface ThreadPendingOperation {
  operation: ThreadPendingOperationType;
  status: ThreadPendingOperationStatus;
  operationId: string;
  requestedAt: number;
}

export type ThreadStatus =
  | "created"
  | "provisioning"
  | "provisioned"
  | "provisioning_failed"
  | "error"
  | "idle"
  | "active";

export type ThreadType = "standard" | "manager";

export interface ThreadQueuedMessage {
  id: string;
  input: PromptInput[];
  model?: string;
  serviceTier?: ServiceTier;
  reasoningLevel: ReasoningLevel;
  sandboxMode: SandboxMode;
  createdAt: number;
}

export interface Thread {
  id: string;
  projectId: string;
  providerId: string;
  type: ThreadType;
  title?: string;
  mergeBaseBranch?: string;
  titleFallback?: string;
  status: ThreadStatus;
  workStatus?: ThreadWorkStatus;
  primaryCheckout?: ThreadPrimaryCheckoutState;
  provisioningState?: ThreadProvisioningState;
  queuedMessages?: ThreadQueuedMessage[];
  pendingOperation?: ThreadPendingOperation;
  environmentId?: string;
  attachedEnvironment?: EnvironmentRecord;
  builtInActions?: ThreadBuiltInAction[];
  defaultExecutionOptions?: ThreadExecutionOptions;
  parentThreadId?: string;
  archivedAt?: number;
  lastReadAt?: number;
  createdAt: number;
  updatedAt: number;
}

export interface PersistedEnvironmentRecord {
  kind: string;
  state: unknown;
}

export type ThreadWorkState =
  | "clean"
  | "untracked"
  | "deleted"
  | "dirty_uncommitted"
  | "committed_unmerged"
  | "dirty_and_committed_unmerged";

export interface ThreadWorkStatus {
  state: ThreadWorkState;
  changedFiles: number;
  insertions: number;
  deletions: number;
  workspaceChangedFiles: number;
  workspaceInsertions: number;
  workspaceDeletions: number;
  hasUncommittedChanges: boolean;
  hasCommittedUnmergedChanges: boolean;
  aheadCount: number;
  behindCount: number;
  currentBranch?: string;
  defaultBranch?: string;
  mergeBaseBranch?: string;
  mergeBaseBranches?: string[];
  baseRef?: string;
  files?: ThreadWorkFileChange[];
}

export interface ThreadWorkFileChange {
  path: string;
  status: string;
}

export interface ThreadPrimaryCheckoutState {
  isActive: boolean;
  promotedAt?: number;
}

export type ThreadProvisioningReadiness = "ready" | "degraded" | "failed";

export interface ThreadProvisioningState {
  readiness: ThreadProvisioningReadiness;
  message?: string;
  fallbackReason?: string;
}

export type AppThreadEventType =
  | "client/thread/start"
  | "client/turn/requested"
  | "client/turn/start"
  | "system/error"
  | "system/manager/user_message"
  | "system/thread/interrupted"
  | "system/thread-title/updated"
  | "system/thread_operation"
  | "system/primary_checkout/updated"
  | "system/worktree/commit"
  | "system/worktree/squash_merge"
  | "system/provisioning/started"
  | "system/provisioning/progress"
  | "system/provisioning/env_setup"
  | "system/provisioning/fallback"
  | "system/provisioning/completed"
  | "system/provisioning/cleanup_failed";

export const PROVIDER_EVENT_ENVELOPE_SCHEMA =
  "bb/provider-event-envelope" as const;
export const PROVIDER_EVENT_ENVELOPE_VERSION = 1 as const;

export interface ProviderEventEnvelopeMetadata {
  schema: typeof PROVIDER_EVENT_ENVELOPE_SCHEMA;
  version: typeof PROVIDER_EVENT_ENVELOPE_VERSION;
  providerId: string;
  method: string;
  observedAt: number;
}

export interface ProviderEventEnvelope<TPayload = unknown> {
  __bb_provider_event: ProviderEventEnvelopeMetadata;
  payload: TPayload;
}

export type ThreadTurnInitiator = "user" | "agent" | "system";

export interface ClientExecutionOptionsSnapshot {
  model?: string;
  serviceTier?: ServiceTier;
  reasoningLevel?: ReasoningLevel;
  sandboxMode?: SandboxMode;
  approvalPolicy?: string;
}

export interface ClientOutboundStartEventData {
  direction: "outbound";
  source: "spawn" | "tell";
  initiator?: ThreadTurnInitiator;
  input?: PromptInput[];
  request: {
    method: "thread/start" | "turn/start";
    params: Record<string, unknown>;
  };
  execution: ClientExecutionOptionsSnapshot;
}

export interface SystemErrorEventData {
  code?: string;
  message: string;
  detail?: string;
}

export interface SystemThreadTitleUpdatedEventData {
  title: string;
  previousTitle?: string;
  source: "provider";
  providerMethod?: string;
}

export interface SystemPrimaryCheckoutUpdatedEventData {
  action: "promote" | "demote";
  status: "started" | "completed" | "failed" | "noop";
  message: string;
  projectId: string;
  activeThreadId?: string;
  branch?: string;
}

export interface SystemThreadOperationEventData {
  operation: "commit" | "squash_merge";
  status: "requested" | "queued" | "running" | "completed" | "failed";
  message: string;
  operationId?: string;
  demotedPrimaryCheckout?: boolean;
}

export interface SystemThreadInterruptedEventData {
  reason: "user";
  message?: string;
}

export type ThreadProvisioningReason =
  | "thread-created"
  | "boot-created-thread"
  | "tell-after-provisioning-failure"
  | "tell-after-missing-environment-attachment"
  | "resume-missing-provider-thread";

export type ThreadEnvironmentStartReason =
  | ThreadProvisioningReason
  | "boot-active-resume"
  | "resume-existing-provider-session";

export interface ProvisioningTranscriptEntry {
  key: string;
  text: string;
  metadata?: Record<string, unknown>;
  startedAt?: number;
}

export interface SystemProvisioningStartedEventData {
  attachedEnvironmentId?: string;
  reason?: ThreadProvisioningReason;
  transcript: ProvisioningTranscriptEntry[];
}

export type ThreadProvisioningProgressPhase =
  | "prepare_environment"
  | "start_provider_session";

export type ThreadProvisioningProgressStatus =
  | "started"
  | "completed"
  | "failed";

export interface SystemProvisioningProgressEventData {
  phase: ThreadProvisioningProgressPhase;
  status: ThreadProvisioningProgressStatus;
  durationMs?: number;
  transcript: ProvisioningTranscriptEntry[];
}

export interface SystemProvisioningEnvSetupEventData {
  setup: {
    status: "started" | "running" | "completed" | "failed";
    scriptPath: string;
    timeoutMs?: number;
    durationMs?: number;
    output?: string;
  };
  workspaceRoot?: string;
  reason?: ThreadEnvironmentStartReason;
  transcript: ProvisioningTranscriptEntry[];
}

export interface SystemProvisioningFallbackEventData {
  requestedEnvironmentId: string;
  fallbackEnvironmentId: string;
  detail?: string;
  transcript: ProvisioningTranscriptEntry[];
}

export interface SystemProvisioningCompletedEventData {
  attachedEnvironmentId?: string;
  providerThreadId?: string;
  workspaceRoot?: string;
  reason?: ThreadProvisioningReason;
  transcript: ProvisioningTranscriptEntry[];
}

export interface SystemProvisioningCleanupFailedEventData {
  message: string;
  detail?: string;
}

export interface SystemWorktreeCommitEventData {
  status: "committed" | "noop";
  message: string;
  commitSha?: string;
  commitSubject?: string;
  includeUnstaged?: boolean;
}

export interface SystemWorktreeSquashMergeEventData {
  status: "merged" | "noop" | "conflict";
  message: string;
  committed?: boolean;
  commitSha?: string;
  commitSubject?: string;
  mergeBaseBranch?: string;
  conflictFiles?: string[];
}

export interface SystemManagerUserMessageEventData {
  text: string;
  toolCallId?: string;
  turnId?: string;
}

export type ThreadEventType = CodexServerNotificationMethod | AppThreadEventType;

export interface TurnLifecycleEventData {
  turnId?: string;
  input?: PromptInput[];
}

export type ThreadEventDataByType = CodexServerNotificationParamsByMethod & {
  "client/thread/start": ClientOutboundStartEventData;
  "client/turn/requested": ClientOutboundStartEventData;
  "client/turn/start": ClientOutboundStartEventData;
  "system/error": SystemErrorEventData;
  "system/manager/user_message": SystemManagerUserMessageEventData;
  "system/thread/interrupted": SystemThreadInterruptedEventData;
  "system/thread-title/updated": SystemThreadTitleUpdatedEventData;
  "system/thread_operation": SystemThreadOperationEventData;
  "system/primary_checkout/updated": SystemPrimaryCheckoutUpdatedEventData;
  "system/worktree/commit": SystemWorktreeCommitEventData;
  "system/worktree/squash_merge": SystemWorktreeSquashMergeEventData;
  "system/provisioning/started": SystemProvisioningStartedEventData;
  "system/provisioning/progress": SystemProvisioningProgressEventData;
  "system/provisioning/env_setup": SystemProvisioningEnvSetupEventData;
  "system/provisioning/fallback": SystemProvisioningFallbackEventData;
  "system/provisioning/completed": SystemProvisioningCompletedEventData;
  "system/provisioning/cleanup_failed": SystemProvisioningCleanupFailedEventData;
};

export type ThreadEventData =
  | ThreadEventDataByType[ThreadEventType]
  | ProviderEventEnvelope;

export type ThreadEventDataForType<TType extends ThreadEventType> =
  ThreadEventDataByType[TType];

export type PersistedThreadEventDataForType<TType extends ThreadEventType> =
  TType extends AppThreadEventType
    ? ThreadEventDataForType<TType>
    : ThreadEventDataForType<TType> | ProviderEventEnvelope;

export type PersistedThreadEventData = PersistedThreadEventDataForType<ThreadEventType>;

// Event (streaming log from codex)
export interface ThreadEvent<
  TType extends ThreadEventType = ThreadEventType,
> {
  id: string;
  threadId: string;
  seq: number;
  type: TType;
  data: PersistedThreadEventDataForType<TType>;
  createdAt: number;
}

export type ThreadEventOfType<TType extends ThreadEventType> = ThreadEvent<
  TType
>;
