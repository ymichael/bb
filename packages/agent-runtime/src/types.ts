import type {
  AvailableModel,
  ClientTurnRequestId,
  DynamicTool,
  InstructionMode,
  PendingInteractionCreate,
  PendingInteractionResolution,
  PromptInput,
  RuntimeThreadExecutionOptions,
  ThreadEvent,
  ToolCallRequest,
  ToolCallResponse,
} from "@bb/domain";
import type { AgentRuntimeCaptureEntry } from "./capture-types.js";

export type AgentRuntimeShellEnvironment = Record<string, string>;

export type AgentRuntimeExecutionOptions = RuntimeThreadExecutionOptions;

export interface AgentRuntimeProcessExitInfo {
  providerId: string;
  threadIds: string[];
  code: number | null;
  signal: string | null;
}

// ---------------------------------------------------------------------------
// Runtime options
// ---------------------------------------------------------------------------

export interface AgentRuntimeOptions {
  /** Working directory for provider processes. */
  workspacePath: string;

  /** Extra paths workspace-write providers may mutate in addition to workspacePath. */
  additionalWorkspaceWriteRoots?: readonly string[];

  /** Environment variables passed to ALL provider processes. */
  env?: Record<string, string>;

  /** Environment variables injected into agent shell execution via adapters. */
  shellEnv?: AgentRuntimeShellEnvironment;

  /** Optional directory containing bundled provider bridges. */
  bridgeBundleDir?: string;

  /** Called when a provider emits a translated event.
   *  Every event has `threadId` (bb ID) and `providerThreadId` (provider's internal ID). */
  onEvent: (event: ThreadEvent) => void;

  /** Called when runtime audit capture is enabled by a harness or test. */
  onCapture?: (entry: AgentRuntimeCaptureEntry) => void;

  /** Called when a provider needs to execute a tool.
   *  `threadId` is always the BB thread id and `providerThreadId` is always present. */
  onToolCall: (request: ToolCallRequest) => Promise<ToolCallResponse>;

  /** Called when a provider pauses for user permission or approval.
   *  The runtime converts provider-native requests into bb's shared pending-interaction contract. */
  onInteractiveRequest?: (
    request: PendingInteractionCreate,
  ) => Promise<PendingInteractionResolution>;

  /** Called on provider stderr lines. */
  onStderr?: (line: string, threadId?: string) => void;

  /** Called when a provider process exits unexpectedly. */
  onProcessExit?: (info: AgentRuntimeProcessExitInfo) => void;
}

// ---------------------------------------------------------------------------
// Runtime interface
// ---------------------------------------------------------------------------

export interface EnsureProviderArgs {
  providerId: string;
  forThreadId?: string;
}

export interface StartThreadArgs {
  environmentId: string;
  threadId: string;
  projectId: string;
  providerId: string;
  clientRequestId?: ClientTurnRequestId;
  input?: PromptInput[];
  options: AgentRuntimeExecutionOptions;
  instructions?: string;
  dynamicTools?: DynamicTool[];
  disallowedTools?: readonly string[];
  instructionMode?: InstructionMode;
}

export interface StartThreadResult {
  providerThreadId: string;
}

export interface ResumeThreadArgs {
  environmentId: string;
  threadId: string;
  projectId?: string;
  providerThreadId?: string;
  providerId: string;
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
  clientRequestId: ClientTurnRequestId;
  options: AgentRuntimeExecutionOptions;
  instructions?: string;
}

export interface SteerTurnArgs {
  threadId: string;
  expectedTurnId: string;
  input: PromptInput[];
  clientRequestId: ClientTurnRequestId;
  options: AgentRuntimeExecutionOptions;
  instructions?: string;
}

export interface SteerTurnAppliedResult {
  status: "steered";
}

export interface SteerTurnStaleResult {
  status: "stale";
  activeTurnId: string | null;
}

export type SteerTurnResult = SteerTurnAppliedResult | SteerTurnStaleResult;

export interface StopThreadArgs {
  threadId: string;
}

export interface RenameThreadArgs {
  threadId: string;
  title: string;
}

export interface ArchiveThreadArgs {
  providerId: string;
  providerThreadId: string;
  threadId: string;
}

export interface UnarchiveThreadArgs {
  providerId: string;
  providerThreadId: string;
  threadId: string;
}

export interface ListModelsArgs {
  providerId: string;
}

export interface AgentRuntime {
  ensureProvider(args: EnsureProviderArgs): Promise<void>;

  startThread(args: StartThreadArgs): Promise<StartThreadResult>;

  resumeThread(args: ResumeThreadArgs): Promise<ResumeThreadResult>;

  runTurn(args: RunTurnArgs): Promise<void>;

  steerTurn(args: SteerTurnArgs): Promise<SteerTurnResult>;

  stopThread(args: StopThreadArgs): Promise<void>;

  renameThread(args: RenameThreadArgs): Promise<void>;

  archiveThread(args: ArchiveThreadArgs): Promise<void>;

  unarchiveThread(args: UnarchiveThreadArgs): Promise<void>;

  listModels(args: ListModelsArgs): Promise<{
    models: AvailableModel[];
    selectedOnlyModels: AvailableModel[];
  }>;

  listRunningProviders(): string[];

  shutdown(): Promise<void>;
}
