import type {
  CodexServerNotificationMethod,
  CodexServerNotificationParamsByMethod,
} from "./generated/codex-app-server/index.js";
import type {
  PromptInput,
  ReasoningLevel,
  SandboxMode,
} from "./shared-types.js";

// Project
export interface Project {
  id: string;
  name: string;
  rootPath: string;
  workflowInstructions?: string;
  rootPathExists?: boolean;
  createdAt: number;
  updatedAt: number;
}

// Thread
export type WorkflowKind = "noop" | "branch-commit-merge";
export type EnvironmentCapability =
  | "host_filesystem"
  | "isolated_workspace"
  | "promote_primary_checkout"
  | "demote_primary_checkout"
  | "squash_merge";

export type EnvironmentCapabilities = Record<EnvironmentCapability, boolean>;

export interface WorkflowCompatibilityResult {
  ok: boolean;
  missingRequirements: Array<{
    capability: string;
    reason: string;
  }>;
}

export interface WorkflowDefinitionSummary {
  kind: WorkflowKind;
  displayName: string;
  description?: string;
  requiredEnvironmentCapabilities: EnvironmentCapability[];
}

export interface ThreadWorkflowState {
  phase: "preparing" | "working" | "completed" | "failed";
  summary: string;
  terminal: boolean;
  successful?: boolean;
}

export type ThreadStatus =
  | "created"
  | "provisioning"
  | "provisioning_failed"
  | "idle"
  | "active";

export interface ThreadQueuedMessage {
  id: string;
  input: PromptInput[];
  model?: string;
  reasoningLevel: ReasoningLevel;
  sandboxMode: SandboxMode;
  createdAt: number;
}

export interface Thread {
  id: string;
  projectId: string;
  title?: string;
  titleFallback?: string;
  status: ThreadStatus;
  workStatus?: ThreadWorkStatus;
  primaryCheckout?: ThreadPrimaryCheckoutState;
  provisioningState?: ThreadProvisioningState;
  queuedMessages?: ThreadQueuedMessage[];
  environmentId?: string;
  environmentRecord?: PersistedEnvironmentRecord;
  workflowId?: WorkflowKind;
  workflowState?: ThreadWorkflowState;
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
  | "client/turn/start"
  | "system/error"
  | "system/thread-title/updated"
  | "system/thread_operation"
  | "system/primary_checkout/updated"
  | "system/worktree/commit"
  | "system/worktree/squash_merge"
  | "system/provisioning/started"
  | "system/provisioning/env_setup"
  | "system/provisioning/fallback"
  | "system/provisioning/completed"
  | "system/provisioning/cleanup_failed";

export const PROVIDER_EVENT_ENVELOPE_SCHEMA =
  "beanbag/provider-event-envelope" as const;
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

export interface SystemProvisioningStartedEventData {
  environmentId: string;
  environmentDisplayName?: string;
}

export interface SystemProvisioningEnvSetupEventData {
  status: "started" | "completed" | "failed";
  scriptPath: string;
  timeoutMs?: number;
  durationMs?: number;
  detail?: string;
}

export interface SystemProvisioningFallbackEventData {
  requestedEnvironmentId: string;
  fallbackEnvironmentId: string;
  reason: string;
  detail?: string;
}

export interface SystemProvisioningCompletedEventData {
  environmentId: string;
  fallbackReason?: string;
}

export interface SystemProvisioningCleanupFailedEventData {
  environmentId: string;
  message: string;
  detail?: string;
}

export interface SystemWorktreeCommitEventData {
  status: "committed" | "noop";
  message: string;
  commitSha?: string;
  includeUnstaged?: boolean;
}

export interface SystemWorktreeSquashMergeEventData {
  status: "merged" | "noop" | "conflict";
  message: string;
  committed?: boolean;
  mergeBaseBranch?: string;
  conflictFiles?: string[];
}

export type ThreadEventType = CodexServerNotificationMethod | AppThreadEventType;

export interface TurnLifecycleEventData {
  turnId?: string;
  input?: PromptInput[];
}

export type ThreadEventDataByType = CodexServerNotificationParamsByMethod & {
  "client/thread/start": ClientOutboundStartEventData;
  "client/turn/start": ClientOutboundStartEventData;
  "system/error": SystemErrorEventData;
  "system/thread-title/updated": SystemThreadTitleUpdatedEventData;
  "system/thread_operation": SystemThreadOperationEventData;
  "system/primary_checkout/updated": SystemPrimaryCheckoutUpdatedEventData;
  "system/worktree/commit": SystemWorktreeCommitEventData;
  "system/worktree/squash_merge": SystemWorktreeSquashMergeEventData;
  "system/provisioning/started": SystemProvisioningStartedEventData;
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
