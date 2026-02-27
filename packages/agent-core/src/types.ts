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
export type ThreadStatus =
  | "created"
  | "provisioning"
  | "provisioning_failed"
  | "idle"
  | "active";

export interface Thread {
  id: string;
  projectId: string;
  title?: string;
  status: ThreadStatus;
  workStatus?: ThreadWorkStatus;
  provisioningState?: ThreadProvisioningState;
  agentDiffStats?: ThreadAgentDiffStats;
  environmentId?: string;
  parentThreadId?: string;
  archivedAt?: number;
  lastReadAt?: number;
  createdAt: number;
  updatedAt: number;
}

export type ThreadAgentDiffSource = "worktree_snapshot" | "local_tally";

export interface ThreadAgentDiffStats {
  source: ThreadAgentDiffSource;
  changedFiles: number;
  insertions: number;
  deletions: number;
  capturedAt: number;
}

export type ThreadWorkState =
  | "clean"
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
  workspaceRoot?: string;
  baseRef?: string;
  files?: ThreadWorkFileChange[];
}

export interface ThreadWorkFileChange {
  path: string;
  status: string;
}

export type ThreadProvisioningReadiness = "ready" | "degraded" | "failed";

export interface ThreadProvisioningState {
  readiness: ThreadProvisioningReadiness;
  message?: string;
  mode?: string;
  fallbackReason?: string;
}

export type AppThreadEventType =
  | "client/thread/start"
  | "client/turn/start"
  | "system/error"
  | "system/thread-title/updated"
  | "system/provisioning/started"
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

export interface SystemProvisioningStartedEventData {
  environmentId: string;
  environmentDisplayName?: string;
}

export interface SystemProvisioningFallbackEventData {
  requestedEnvironmentId: string;
  fallbackEnvironmentId: string;
  reason: string;
  detail?: string;
}

export interface SystemProvisioningCompletedEventData {
  environmentId: string;
  workspaceRoot?: string;
  mode?: string;
  fallbackReason?: string;
}

export interface SystemProvisioningCleanupFailedEventData {
  environmentId: string;
  message: string;
  detail?: string;
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
  "system/provisioning/started": SystemProvisioningStartedEventData;
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
