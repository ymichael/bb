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
import type { PromptInput, ReasoningLevel, SandboxMode } from "./shared-types.js";
import type {
  Thread,
  ThreadEvent,
  ThreadWorkStatus,
  ThreadTurnInitiator,
} from "./types.js";

export interface ProviderExecutionOptions {
  model?: string;
  reasoningLevel?: ReasoningLevel;
  sandboxMode?: SandboxMode;
}

export interface ProviderThreadContext {
  projectId: string;
  threadId: string;
  path?: string;
  workspaceRoot?: string;
  environmentId?: string;
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

export interface ProviderAdapter {
  id: string;
  displayName: string;
  capabilities: ProviderCapabilities;
  processCommand: string;
  processArgs: string[];
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
  ): Record<string, unknown>;
  createThreadResumeParams(
    providerThreadId: string,
    context: ProviderThreadContext,
    options?: ProviderExecutionOptions,
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
  generateThreadTitle?(
    args: ProviderTitleGeneratorArgs,
  ): Promise<string | undefined>;
  generateCommitMessage?(
    args: ProviderCommitMessageGeneratorArgs,
  ): Promise<string | undefined>;
  inactiveSessionErrorMessage(threadId: string): string;
}

export interface EnvironmentPrepareContext {
  projectId: string;
  threadId: string;
  projectRootPath: string;
  runtimeEnv: Record<string, string | undefined>;
  onProvisioningEvent?: (event: EnvironmentProvisioningEvent) => void;
}

export interface EnvironmentInstructionsContext {
  projectId: string;
  threadId: string;
  projectRootPath: string;
  workspaceRootPath: string;
  requestedEnvironmentId: string;
  effectiveEnvironmentId: string;
  mode?: string;
  fallbackReason?: string;
}

export interface EnvironmentSession {
  cwd: string;
  env?: Record<string, string | undefined>;
  metadata?: Record<string, string>;
  cleanup?: () => Promise<void> | void;
}

export type EnvironmentProvisioningEvent =
  | {
      type: "env-setup";
      status: "started" | "completed" | "failed";
      scriptPath: string;
      workspaceRoot?: string;
      timeoutMs?: number;
      durationMs?: number;
      detail?: string;
    };

export interface EnvironmentAdapter {
  info: SystemEnvironmentInfo;
  prepare(context: EnvironmentPrepareContext): EnvironmentSession;
  prepareAsync?(
    context: EnvironmentPrepareContext,
  ): Promise<EnvironmentSession>;
  customizeDeveloperInstructions?(
    currentInstructions: string | undefined,
    context: EnvironmentInstructionsContext,
  ): string | undefined;
}

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
  systemTell(
    threadId: string,
    request: TellThreadRequest,
    options?: ProviderExecutionOptions,
  ): Promise<void>;
  stop(threadId: string): void;
  archive(threadId: string): void;
  unarchive(threadId: string): void;
  updateThread(threadId: string, request: { title?: string }): Thread;
  markRead(threadId: string): Thread;
  markUnread(threadId: string): Thread;
  requestThreadOperation(
    threadId: string,
    request: ThreadOperationRequest,
  ): Promise<ThreadOperationResponse>;
  promoteThread(threadId: string): Promise<PromoteThreadResponse>;
  demotePrimaryCheckout(threadId: string): Promise<DemotePrimaryResponse>;
  getPrimaryCheckoutStatus(projectId: string): PrimaryCheckoutStatus;
  getById(threadId: string): Thread | undefined;
  getWorkStatus(threadId: string, mergeBaseBranch?: string): ThreadWorkStatus | undefined;
  getEvents(threadId: string, afterSeq?: number, limit?: number): ThreadEvent[];
  getTimeline(
    threadId: string,
    limit?: number,
    includeToolGroupMessages?: boolean,
  ): ThreadTimelineResponse;
  getToolGroupMessages(
    threadId: string,
    request: ThreadToolGroupMessagesRequest,
  ): ThreadToolGroupMessagesResponse;
  getGitDiff(
    threadId: string,
    selection?: ThreadGitDiffSelection,
    mergeBaseBranch?: string,
  ): ThreadGitDiffResponse;
  getOutput(threadId: string): string | undefined;
  getDefaultExecutionOptions(
    threadId: string,
  ): ThreadExecutionOptions | undefined;
  list(filters?: ThreadListFilters): Thread[];
  isActive(threadId: string): boolean;
  getActiveCount(): number;
  getRunningCount(): number;
  listModels(): Promise<AvailableModel[]>;
  getProviderInfo(): SystemProviderInfo;
  listProviders(): SystemProviderInfo[];
  getEnvironmentInfo(): SystemEnvironmentInfo;
  listEnvironments(): SystemEnvironmentInfo[];
  reconcileActiveThreadsOnBoot(): Promise<void>;
  stopAll(): void;
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
