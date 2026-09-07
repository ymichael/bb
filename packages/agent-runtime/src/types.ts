import type {
  PermissionMode,
  AvailableModel,
  ClientTurnRequestId,
  DynamicTool,
  InstructionMode,
  JsonObject,
  PendingInteractionCreate,
  PendingInteractionResolution,
  PromptInput,
  ProviderFork,
  ProviderRecoveryKind,
  RuntimeThreadExecutionOptions,
  ThreadEvent,
  ToolCallRequest,
  ToolCallResponse,
} from "@bb/domain";
import type {
  ProviderHealthResult,
  ProviderInstallationRunResult,
  ProviderInstallationStatus,
  ProviderUsageResult,
  SkillsConfigureRoot,
} from "@bb/provider-bridge-protocol";

export type AgentRuntimeShellEnvironment = Record<string, string>;

export interface AgentRuntimeContributedEnvEntry {
  name: string;
  value: string | { serverPath: string };
  source: { plugin: string };
  reason: string;
  secret: boolean;
}

export type AgentRuntimeExecutionOptions = RuntimeThreadExecutionOptions;

export type AgentRuntimeSkillRoot = SkillsConfigureRoot;

export interface AgentRuntimeProcessExitThreadState {
  activeTurnId: string | null;
  pendingTurnStart: boolean;
  providerThreadId: string | null;
  threadId: string;
}

export interface AgentRuntimeProcessExitInfo {
  providerId: string;
  threads: AgentRuntimeProcessExitThreadState[];
  code: number | null;
  expected: boolean;
  signal: string | null;
  stderr: string | null;
}

export interface AgentRuntimeOptions {
  workspacePath: string;

  additionalWorkspaceWriteRoots?: readonly string[];

  env?: Record<string, string>;

  shellEnv?: AgentRuntimeShellEnvironment;

  threadStorageRootPath?: string;

  bridgeBundleDir?: string;
  turnStartWatchdog?: { thresholdMs?: number; intervalMs?: number };
  rateLimitRetry?: { delaysMs?: readonly number[] };
  threadCreation?: { requestTimeoutMs?: number };

  skillRoots?: readonly AgentRuntimeSkillRoot[];

  onEvent: (event: ThreadEvent) => void;

  onToolCall: (request: ToolCallRequest) => Promise<ToolCallResponse>;

  onInteractiveRequest?: (
    request: PendingInteractionCreate,
  ) => Promise<PendingInteractionResolution>;

  onStderr?: (line: string, threadId?: string) => void;

  onProcessExit?: (info: AgentRuntimeProcessExitInfo) => void;

  onProviderRecovery?: (hint: AgentRuntimeProviderRecoveryHint) => void;
}

export interface AgentRuntimeProviderRecoveryHint {
  providerId: string;
  threadId?: string;
  kind: ProviderRecoveryKind;
  message: string;
  retryable: boolean;
}

export interface AgentRuntimeBridgeLaunch {
  pluginId: string;
  dataDir: string;
  source: { kind: "artifact"; digest: string; artifactPath: string };
  capabilities: {
    providerInstallation: boolean;
    supportsServiceTier: boolean;
    permissionModes: PermissionMode[];
    supportsThreadArchive: boolean;
    supportsThreadRename: boolean;
    fork: ProviderFork;
  };
  providerOptions: JsonObject;
  envPassthrough: readonly string[];
}

export interface EnsureProviderArgs {
  bridgeLaunch: AgentRuntimeBridgeLaunch;
  providerId: string;
}

export interface StartThreadArgs {
  bridgeLaunch: AgentRuntimeBridgeLaunch;
  environmentId: string;
  threadId: string;
  projectId: string;
  providerId: string;
  contributedEnv?: readonly AgentRuntimeContributedEnvEntry[];
  clientRequestId?: ClientTurnRequestId;
  input?: PromptInput[];
  inputGroups?: PromptInput[][];
  options: AgentRuntimeExecutionOptions;
  instructions?: string;
  dynamicTools?: DynamicTool[];
  disallowedTools?: readonly string[];
  instructionMode?: InstructionMode;
  fork?: {
    sourceProviderThreadId: string;
    sourceProviderCheckpointId?: string;
  };
}

export interface StartThreadResult {
  providerThreadId: string;
}

interface PrepareThreadRewindArgs {
  bridgeLaunch: AgentRuntimeBridgeLaunch;
  environmentId: string;
  threadId: string;
  leaseId: string;
  projectId: string;
  providerId: string;
  contributedEnv?: readonly AgentRuntimeContributedEnvEntry[];
  sourceProviderThreadId: string;
  retainThroughProviderCheckpoint: string;
  options: AgentRuntimeExecutionOptions;
  instructions?: string;
  dynamicTools?: DynamicTool[];
  disallowedTools?: readonly string[];
  instructionMode?: InstructionMode;
}

interface PrepareThreadRewindResult {
  providerThreadId: string;
}

interface DiscardThreadRewindArgs {
  leaseId: string;
}

export interface ResumeThreadArgs {
  bridgeLaunch: AgentRuntimeBridgeLaunch;
  environmentId: string;
  threadId: string;
  projectId?: string;
  providerThreadId?: string;
  providerId: string;
  contributedEnv?: readonly AgentRuntimeContributedEnvEntry[];
  options: AgentRuntimeExecutionOptions;
  instructions?: string;
  dynamicTools?: DynamicTool[];
  disallowedTools?: readonly string[];
  instructionMode?: InstructionMode;
}

export interface ResumeThreadResult {
  providerThreadId: string;
}

export interface RunTurnArgs {
  threadId: string;
  input: PromptInput[];
  inputGroups?: PromptInput[][];
  clientRequestId: ClientTurnRequestId;
  options: AgentRuntimeExecutionOptions;
  contributedEnv?: readonly AgentRuntimeContributedEnvEntry[];
  instructions?: string;
}

export interface SteerTurnArgs {
  threadId: string;
  expectedTurnId: string;
  input: PromptInput[];
  inputGroups?: PromptInput[][];
  clientRequestId: ClientTurnRequestId;
  options: AgentRuntimeExecutionOptions;
  contributedEnv?: readonly AgentRuntimeContributedEnvEntry[];
  instructions?: string;
}

interface SteerTurnAppliedResult {
  status: "steered";
}

interface SteerTurnStaleResult {
  status: "stale";
  activeTurnId: string | null;
}

export type SteerTurnResult = SteerTurnAppliedResult | SteerTurnStaleResult;

export interface StopThreadArgs {
  threadId: string;
}

export interface StopThreadResult {
  providerCheckpointId: string | null;
}

export interface AgentRuntimeProviderSession {
  providerId: string;
  providerThreadId: string;
}

export interface WaitForActiveTurnArgs {
  timeoutMs: number;
}

export interface ReapIdleProviderSessionsArgs {
  idleForMs: number;
  nowMs: number;
  runThreadExclusive?: (
    threadId: string,
    work: () => Promise<ReapedIdleProviderSession | null>,
  ) => Promise<ReapedIdleProviderSession | null>;
}

export interface ReapedIdleProviderSession {
  idleForMs: number;
  providerId: string;
  providerThreadId: string;
  threadId: string;
}

export interface ReapIdleProviderSessionsResult {
  reapedSessions: ReapedIdleProviderSession[];
}

export interface RenameThreadArgs {
  threadId: string;
  title: string;
}

interface ClearThreadGoalArgs {
  threadId: string;
}

interface ArchiveThreadArgs {
  bridgeLaunch: AgentRuntimeBridgeLaunch;
  providerId: string;
  providerThreadId: string;
  threadId: string;
}

interface UnarchiveThreadArgs {
  bridgeLaunch: AgentRuntimeBridgeLaunch;
  providerId: string;
  providerThreadId: string;
  threadId: string;
}

export interface ListModelsArgs {
  providerId: string;
  bridgeLaunch: AgentRuntimeBridgeLaunch;
  cwd?: string;
}

interface ProviderMaintenanceArgs {
  providerId: string;
  bridgeLaunch: AgentRuntimeBridgeLaunch;
  cwd?: string;
}

interface ProviderInstallationStatusArgs extends ProviderMaintenanceArgs {
  requirement?: "thread_rewind";
}

export interface AgentRuntime {
  ensureProvider(args: EnsureProviderArgs): Promise<void>;

  startThread(args: StartThreadArgs): Promise<StartThreadResult>;

  prepareThreadRewind(
    args: PrepareThreadRewindArgs,
  ): Promise<PrepareThreadRewindResult>;

  discardThreadRewind(args: DiscardThreadRewindArgs): Promise<void>;

  resumeThread(args: ResumeThreadArgs): Promise<ResumeThreadResult>;

  runTurn(args: RunTurnArgs): Promise<void>;

  steerTurn(args: SteerTurnArgs): Promise<SteerTurnResult>;

  stopThread(args: StopThreadArgs): Promise<StopThreadResult>;

  clearThreadGoal(args: ClearThreadGoalArgs): Promise<{ cleared: boolean }>;

  renameThread(args: RenameThreadArgs): Promise<void>;

  archiveThread(args: ArchiveThreadArgs): Promise<void>;

  unarchiveThread(args: UnarchiveThreadArgs): Promise<void>;

  listModels(args: ListModelsArgs): Promise<{
    models: AvailableModel[];
    selectedOnlyModels: AvailableModel[];
  }>;

  providerHealth(args: ProviderMaintenanceArgs): Promise<ProviderHealthResult>;

  providerUsage(args: ProviderMaintenanceArgs): Promise<ProviderUsageResult>;

  providerInstallationStatus(
    args: ProviderInstallationStatusArgs,
  ): Promise<ProviderInstallationStatus>;

  providerInstallationRun(
    args: ProviderMaintenanceArgs & { action: "install" | "update" },
  ): Promise<ProviderInstallationRunResult>;

  listRunningProviders(): string[];

  getActiveTurnId(threadId: string): string | null;

  waitForActiveTurn(
    threadId: string,
    args: WaitForActiveTurnArgs,
  ): Promise<string | null>;

  getProviderSession(threadId: string): AgentRuntimeProviderSession | null;

  reapIdleProviderSessions(
    args: ReapIdleProviderSessionsArgs,
  ): Promise<ReapIdleProviderSessionsResult>;

  hasThread(threadId: string): boolean;

  getLiveThreadIds(): string[];

  hasOpenBackgroundWork(): boolean;

  shutdown(): Promise<void>;
}
