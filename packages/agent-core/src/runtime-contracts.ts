import type {
  AvailableModel,
  DemotePrimaryResponse,
  EnqueueThreadMessageRequest,
  PrimaryCheckoutStatus,
  PromoteThreadResponse,
  SendQueuedThreadMessageRequest,
  SendQueuedThreadMessageResponse,
  ThreadOperationRequest,
  ThreadOperationResponse,
  ProviderCapabilities,
  SpawnThreadRequest,
  SystemEnvironmentInfo,
  SystemProviderInfo,
  TellThreadRequest,
  ThreadExecutionOptions,
  ThreadGitDiffResponse,
  ThreadGitDiffSelection,
  ThreadTimelineResponse,
  ThreadToolGroupMessagesRequest,
  ThreadToolGroupMessagesResponse,
} from "./api-types.js";
import type {
  PromptInput,
  ReasoningLevel,
  SandboxMode,
  ServiceTier,
} from "./shared-types.js";
import type { ThreadProviderId } from "./thread-provider.js";
import type {
  Thread,
  ThreadEnvironmentStartReason,
  ThreadEvent,
  ThreadWorkStatus,
  ThreadTurnInitiator,
} from "./types.js";

export interface ProviderExecutionOptions {
  model?: string;
  serviceTier?: ServiceTier;
  reasoningLevel?: ReasoningLevel;
  sandboxMode?: SandboxMode;
}

export interface ProviderThreadContext {
  projectId: string;
  threadId: string;
  daemonUrl?: string;
  path?: string;
}

export interface ProviderDynamicTool {
  name: string;
  description: string;
  inputSchema: unknown;
}

export interface ProviderToolCallRequest {
  requestId: string | number;
  threadId: string;
  turnId: string;
  callId: string;
  tool: string;
  arguments: unknown;
}

export type ProviderToolCallOutputItem =
  | {
      type: "inputText";
      text: string;
    }
  | {
      type: "inputImage";
      imageUrl: string;
    };

export interface ProviderToolCallResponse {
  contentItems: ProviderToolCallOutputItem[];
  success: boolean;
}

export interface ProviderTitleGeneratorArgs {
  input: PromptInput[];
  cwd: string;
}

export type ProviderTitleGenerator = (
  args: ProviderTitleGeneratorArgs,
) => Promise<string | undefined>;

export interface ProviderCommitMessageGeneratorArgs {
  cwd: string;
  includeUnstaged?: boolean;
}

export type ProviderCommitMessageGenerator = (
  args: ProviderCommitMessageGeneratorArgs,
) => Promise<string | undefined>;

export type ProviderLaunchFilePlacement = "home";

export interface ProviderLaunchFile {
  path: string;
  content: string;
  placement: ProviderLaunchFilePlacement;
}

export interface ProviderLaunchConfiguration {
  env?: Record<string, string>;
  files?: ProviderLaunchFile[];
}

export interface ProviderAdapter {
  id: ThreadProviderId;
  displayName: string;
  capabilities: ProviderCapabilities;
  processCommand: string;
  processArgs: string[];
  resolveLaunchConfiguration?(
    context: ProviderThreadContext,
  ):
    | ProviderLaunchConfiguration
    | Promise<ProviderLaunchConfiguration | undefined>
    | undefined;
  clientInfo: { name: string; version: string };
  initializeMethod: string;
  createInitializeParams?(
    clientInfo: { name: string; version: string },
  ): Record<string, unknown>;
  threadStartMethod: string;
  threadResumeMethod: string;
  turnStartMethod: string;
  turnSteerMethod?: string;
  threadNameSetMethod?: string;
  createThreadStartParams(
    req: SpawnThreadRequest,
    context: ProviderThreadContext,
    dynamicTools?: ProviderDynamicTool[],
  ): Record<string, unknown>;
  createThreadResumeParams(
    providerThreadId: string,
    context: ProviderThreadContext,
    options?: ProviderExecutionOptions,
    resumePath?: string,
  ): Record<string, unknown>;
  createTurnStartParams(
    providerThreadId: string,
    input: PromptInput[],
    options?: ProviderExecutionOptions,
  ): Record<string, unknown>;
  createTurnSteerParams?(
    providerThreadId: string,
    expectedTurnId: string,
    input: PromptInput[],
  ): Record<string, unknown>;
  createThreadNameSetParams?(
    providerThreadId: string,
    title: string,
  ): Record<string, unknown>;
  extractThreadIdFromResult(result: unknown): string | undefined;
  extractThreadIdFromEventData(data: unknown): string | undefined;
  normalizeEventType(type: string): string;
  shouldPersistEvent?(method: string, data: unknown): boolean;
  shouldBroadcastForEvent(method: string): boolean;
  statusForEvent(method: string): Thread["status"] | undefined;
  titleFromEvent(method: string, data: unknown): string | undefined;
  outputFromEvent(event: ThreadEvent): string | undefined;
  listModels(): Promise<AvailableModel[]>;
  deriveThreadTitle(input?: PromptInput[]): string | undefined;
  inactiveSessionErrorMessage(threadId: string): string;
  decodeToolCallRequest?(
    requestId: string | number,
    method: string,
    params: unknown,
  ): ProviderToolCallRequest | null;
  encodeToolCallResponse?(
    response: ProviderToolCallResponse,
  ): Record<string, unknown>;
}

export type EnvironmentProvisioningEvent =
  | {
      type: "env-setup";
      status: "started" | "running" | "completed" | "failed";
      scriptPath: string;
      workspaceRoot?: string;
      branchName?: string;
      headSha?: string;
      timeoutMs?: number;
      durationMs?: number;
      detail?: string;
      reason?: ThreadEnvironmentStartReason;
    };

export interface ThreadListFilters {
  projectId?: string;
  parentThreadId?: string;
  includeArchived?: boolean;
  includeWorkStatus?: boolean;
}

export interface ThreadOrchestrator {
  spawn(req: SpawnThreadRequest): Promise<Thread>;
  tell(
    threadId: string,
    request: TellThreadRequest,
    options?: ProviderExecutionOptions,
    context?: { initiator?: ThreadTurnInitiator },
  ): Promise<void>;
  enqueueFollowUp(
    threadId: string,
    request: EnqueueThreadMessageRequest,
  ): Thread;
  removeQueuedFollowUp(threadId: string, queuedMessageId: string): Thread;
  sendQueuedFollowUp(
    threadId: string,
    queuedMessageId: string,
    request?: SendQueuedThreadMessageRequest,
  ): Promise<SendQueuedThreadMessageResponse>;
  deleteThread(threadId: string): Promise<void>;
  systemTell(
    threadId: string,
    request: TellThreadRequest,
    options?: ProviderExecutionOptions,
  ): Promise<void>;
  stop(threadId: string): void;
  archive(threadId: string): Promise<void>;
  unarchive(threadId: string): void;
  requiresForceArchive(threadId: string): boolean;
  updateThread(
    threadId: string,
    request: {
      title?: string;
      mergeBaseBranch?: string | null;
      parentThreadId?: string | null;
    },
  ): Thread;
  markRead(threadId: string): Thread;
  markUnread(threadId: string): Thread;
  requestThreadOperation(
    threadId: string,
    request: ThreadOperationRequest,
  ): Promise<ThreadOperationResponse>;
  promoteThread(threadId: string): Promise<PromoteThreadResponse>;
  demotePrimaryCheckout(threadId: string): Promise<DemotePrimaryResponse>;
  getPrimaryCheckoutStatus(projectId: string): PrimaryCheckoutStatus;
  getRawById(threadId: string): Thread | undefined;
  isPrimaryCheckoutActive(threadId: string): boolean;
  getHydratedByIdAsync(threadId: string): Promise<Thread | undefined>;
  getWorkStatusAsync(
    threadId: string,
    mergeBaseBranch?: string,
  ): Promise<ThreadWorkStatus | undefined>;
  getMergeBaseBranchesAsync(threadId: string): Promise<string[] | undefined>;
  getEvents(threadId: string, afterSeq?: number, limit?: number): ThreadEvent[];
  getTimeline(
    threadId: string,
    limit?: number,
    includeToolGroupMessages?: boolean,
    includeManagerDebugView?: boolean,
  ): ThreadTimelineResponse;
  getToolGroupMessages(
    threadId: string,
    request: ThreadToolGroupMessagesRequest,
  ): ThreadToolGroupMessagesResponse;
  getGitDiffAsync(
    threadId: string,
    selection?: ThreadGitDiffSelection,
    mergeBaseBranch?: string,
  ): Promise<ThreadGitDiffResponse>;
  resolveThreadOpenPath(threadId: string, relativePath: string): string;
  getOutput(threadId: string): string | undefined;
  getDefaultExecutionOptions(
    threadId: string,
  ): ThreadExecutionOptions | undefined;
  list(filters?: ThreadListFilters): Thread[];
  listAsync(filters?: ThreadListFilters): Promise<Thread[]>;
  getProjectWorkspaceStatusAsync(
    projectId: string,
    rootPath: string,
  ): Promise<ThreadWorkStatus>;
  isActive(threadId: string): boolean;
  getActiveCount(): number;
  getRunningCount(): number;
  listModels(): Promise<AvailableModel[]>;
  getProviderInfo(): SystemProviderInfo;
  listProviders(): SystemProviderInfo[];
  listEnvironments(): SystemEnvironmentInfo[];
  reconcileActiveThreadsOnBoot(): Promise<void>;
  stopAll(opts?: { preserveEnvironments?: boolean }): void;
}

export interface ThreadSchedule {
  id: string;
  projectId: string;
  prompt: PromptInput[];
  intervalMinutes: number;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface ScheduleRunRecord {
  id: string;
  scheduleId: string;
  startedAt: number;
  finishedAt?: number;
  status: "running" | "succeeded" | "failed";
  error?: string;
}

export interface SchedulerService {
  listSchedules(): ThreadSchedule[];
  upsertSchedule(schedule: ThreadSchedule): ThreadSchedule;
  deleteSchedule(id: string): boolean;
  listRuns(scheduleId: string): ScheduleRunRecord[];
  tick(nowMs: number): Promise<void> | void;
}
