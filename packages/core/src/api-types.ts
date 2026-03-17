import type {
  PromptInput,
  ReasoningLevel,
  SandboxMode,
  ServiceTier,
} from "./shared-types.js";
import type { ThreadDetailRow } from "./thread-detail-rows.js";
import type { UIMessage } from "./ui-message.js";
import type {
  EnvironmentDescriptor,
  EnvironmentCapabilities,
  ThreadBuiltInAction,
  ThreadBuiltInActionId,
  ThreadQueuedMessage,
  ThreadStatus,
  ThreadTurnInitiator,
  ThreadType,
  ThreadWorkStatus,
} from "./types.js";
export type {
  PromptInput,
  ReasoningLevel,
  SandboxMode,
  ServiceTier,
} from "./shared-types.js";
export type {
  EnvironmentCapabilities,
  ThreadBuiltInAction,
  ThreadBuiltInActionId,
} from "./types.js";

export interface ModelReasoningEffort {
  reasoningEffort: ReasoningLevel;
  description: string;
}

export interface AvailableModel {
  id: string;
  model: string;
  displayName: string;
  description: string;
  supportedReasoningEfforts: ModelReasoningEffort[];
  defaultReasoningEffort: ReasoningLevel;
  isDefault: boolean;
}

export interface EnvironmentCreationArgs {
  kind: string;
}

// Thread endpoints
export interface SpawnThreadRequest {
  projectId: string;
  providerId?: string;
  type?: ThreadType;
  title?: string;
  input?: PromptInput[];
  model?: string;
  serviceTier?: ServiceTier;
  reasoningLevel?: ReasoningLevel;
  sandboxMode?: SandboxMode;
  environmentId?: string;
  environmentDescriptor?: EnvironmentDescriptor;
  environmentCreationArgs?: EnvironmentCreationArgs;
  developerInstructions?: string;
  parentThreadId?: string;
  /**
   * Internal-only override for daemon-authored bootstrap/system turns.
   */
  spawnInitiator?: ThreadTurnInitiator;
}

export type TellThreadMode = "auto" | "start" | "steer";

export interface TellThreadRequest {
  input: PromptInput[];
  model?: string;
  serviceTier?: ServiceTier;
  reasoningLevel?: ReasoningLevel;
  sandboxMode?: SandboxMode;
  mode?: TellThreadMode;
  demotePrimaryIfNeeded?: boolean;
}

export interface EnqueueThreadMessageRequest {
  input: PromptInput[];
  model?: string;
  serviceTier?: ServiceTier;
  reasoningLevel?: ReasoningLevel;
  sandboxMode?: SandboxMode;
}

export interface SendQueuedThreadMessageRequest {
  mode?: "auto" | "steer-if-active" | "steer";
}

export interface SendQueuedThreadMessageResponse {
  ok: true;
  queuedMessage: ThreadQueuedMessage;
}

export interface UpdateThreadRequest {
  title?: string;
  mergeBaseBranch?: string | null;
  parentThreadId?: string | null;
}

export interface ThreadExecutionOptions {
  model?: string;
  serviceTier?: ServiceTier;
  reasoningLevel?: ReasoningLevel;
  sandboxMode?: SandboxMode;
  approvalPolicy?: string;
  source?: "client/thread/start" | "client/turn/requested" | "client/turn/start";
  seq?: number;
}

export interface ThreadToolGroupMessagesRequest {
  turnId: string;
  sourceSeqStart: number;
  sourceSeqEnd: number;
  includeManagerDebugView?: boolean;
}

export interface ThreadToolGroupMessagesResponse {
  messages: UIMessage[];
}

export interface ThreadContextWindowUsage {
  totalTokens: number;
  modelContextWindow: number;
}

export interface ThreadTimelineResponse {
  rows: ThreadDetailRow[];
  contextWindowUsage?: ThreadContextWindowUsage | null;
}

export interface ThreadGitDiffCommitSummary {
  sha: string;
  shortSha: string;
  subject: string;
  authorName?: string;
  authoredAt?: number;
}

export type ThreadGitDiffSelection =
  | { type: "combined" }
  | { type: "commit"; sha: string };

export type ThreadGitDiffMode = "local_uncommitted" | "worktree_commits";

export interface ThreadGitDiffResponse {
  mode: ThreadGitDiffMode;
  currentBranch?: string;
  mergeBaseBranch?: string;
  mergeBaseRef?: string;
  commits: ThreadGitDiffCommitSummary[];
  selection: ThreadGitDiffSelection;
  diff: string;
  truncated: boolean;
}

// Project endpoints
export interface CreateProjectRequest {
  name: string;
  rootPath: string;
}

export interface UpdateProjectRequest {
  name?: string;
  rootPath?: string;
  projectInstructions?: string;
  defaultProviderId?: string | null;
}

export type ThreadOperationType = "commit" | "squash_merge";

export interface CommitOperationOptions {
  message?: string;
  includeUnstaged?: boolean;
  autoArchiveOnSuccess?: boolean;
}

export interface SquashMergeOperationOptions {
  commitIfNeeded?: boolean;
  includeUnstaged?: boolean;
  commitMessage?: string;
  squashMessage?: string;
  mergeBaseBranch?: string;
  autoArchiveOnSuccess?: boolean;
}

export type ThreadOperationRequest =
  | {
      operation: "commit";
      options?: CommitOperationOptions;
    }
  | {
      operation: "squash_merge";
      options?: SquashMergeOperationOptions;
    };

export interface ThreadOperationResponse {
  ok: true;
  operationId: string;
  operation: ThreadOperationType;
  status: "accepted";
  executionStatus: "queued" | "running";
  queued: boolean;
  message: string;
  demotedPrimaryCheckout: boolean;
}

export interface PrimaryCheckoutStatus {
  projectId: string;
  activeThreadId?: string;
  promotedAt?: number;
}

export interface PromoteThreadResponse {
  ok: true;
  promoted: boolean;
  message: string;
  primaryStatus: PrimaryCheckoutStatus;
}

export interface DemotePrimaryResponse {
  ok: true;
  demoted: boolean;
  message: string;
  primaryStatus: PrimaryCheckoutStatus;
}

export interface ProjectFileSuggestion {
  path: string;
}

export type PromptMentionSuggestion =
  | {
      kind: "file";
      path: string;
      replacement: string;
    }
  | {
      kind: "thread";
      path: string;
      replacement: string;
      threadId: string;
      title?: string;
      threadType: ThreadType;
    };

export interface UploadedPromptAttachment {
  type: "localImage" | "localFile";
  path: string;
  name: string;
  mimeType?: string;
  sizeBytes: number;
}

// System
export type OpenPathTarget = "file" | "directory";

export type OpenPathEditor =
  | "system_default"
  | "vscode"
  | "cursor"
  | "zed"
  | "windsurf";

export interface OpenPathRequest {
  path: string;
  target?: OpenPathTarget;
  editor?: OpenPathEditor;
  command?: string;
}

export interface OpenThreadPathRequest {
  relativePath: string;
  target?: OpenPathTarget;
  editor?: OpenPathEditor;
  command?: string;
}

export interface SystemStatus {
  runningThreads: number;
  totalThreads: number;
  uptime: number;
}

export type SystemHealthStorageBucketKey =
  | "database"
  | "database_wal"
  | "database_shm"
  | "daemon_logs"
  | "environment_agent_logs"
  | "worktrees"
  | "attachments"
  | "backups";

export interface SystemHealthStorageBucket {
  key: SystemHealthStorageBucketKey;
  label: string;
  bytes: number;
  paths: string[];
}

export interface SystemHealthDiskSummary {
  path: string;
  availableBytes: number;
  totalBytes: number;
  usedBytes: number;
}

export interface SystemHealthThreadCounts {
  total: number;
  archived: number;
  created: number;
  provisioning: number;
  provisioned: number;
  provisioningFailed: number;
  error: number;
  active: number;
  idle: number;
}

export interface SystemHealthEnvironmentAgentWorker {
  name: string;
  version: string;
  buildId?: string;
}

export interface SystemHealthEnvironmentAgentProvider {
  providerId: string;
  adapterVersion: string;
  runtimeVersion?: string;
}

export interface SystemHealthEnvironmentAgentCapabilities {
  commands: string[];
  features: string[];
}

export interface SystemHealthEnvironmentAgentCompatibility {
  disposition: "reuse" | "degrade" | "replace";
  missingRequiredCommands: string[];
  missingOptionalCommands: string[];
  missingOptionalFeatures: string[];
}

export interface SystemHealthEnvironmentAgentSession {
  sessionId: string;
  threadId: string;
  environmentId?: string;
  agentId: string;
  agentInstanceId: string;
  protocolVersion: number;
  worker?: SystemHealthEnvironmentAgentWorker;
  providers?: SystemHealthEnvironmentAgentProvider[];
  selectedCapabilities?: SystemHealthEnvironmentAgentCapabilities;
  compatibility?: SystemHealthEnvironmentAgentCompatibility;
  controlBaseUrl?: string;
  leaseExpiresAt: number;
  lastHeartbeatAt?: number;
  createdAt: number;
  updatedAt: number;
}

export interface SystemHealthReport {
  generatedAt: number;
  uptime: number;
  projectCount: number;
  runningThreads: number;
  threadCounts: SystemHealthThreadCounts;
  environmentAgent: {
    activeSessionCount: number;
    activeSessions: SystemHealthEnvironmentAgentSession[];
  };
  storage: {
    totalBytes: number;
    disk?: SystemHealthDiskSummary;
    buckets: SystemHealthStorageBucket[];
  };
}

export type SystemRestartAction =
  | "noop";

export interface SystemRestartPolicy {
  restartPolicyByStatus: Record<ThreadStatus, SystemRestartAction>;
  shutdownBlockingStatuses: ThreadStatus[];
  shouldRestart: boolean;
}

export interface SystemShutdownRequest {
  force?: boolean;
}

export interface SystemRestartRequest {
  force?: boolean;
}

export interface SystemShutdownAcceptedResponse {
  ok: true;
  forced: boolean;
  blockingThreadsCount: number;
}

export interface SystemRestartAcceptedResponse extends SystemShutdownAcceptedResponse {
  restarting: true;
}

export interface SystemShutdownBlockingThread {
  id: string;
  projectId: string;
  status: ThreadStatus;
}

export interface SystemShutdownBlockedResponse {
  code: "shutdown_blocked";
  message: string;
  blockingThreads: SystemShutdownBlockingThread[];
}

export interface ProviderCapabilities {
  supportsRename: boolean;
  supportsServiceTier: boolean;
}

export interface SystemProviderInfo {
  id: string;
  displayName: string;
  capabilities: ProviderCapabilities;
}

export interface SystemEnvironmentInfo {
  id: string;
  displayName: string;
  description?: string;
  capabilities: EnvironmentCapabilities;
}
