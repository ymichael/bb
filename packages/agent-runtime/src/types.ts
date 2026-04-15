import type {
  AvailableModel,
  DynamicTool,
  InstructionMode,
  PendingInteractionCreate,
  PendingInteractionResolution,
  PromptInput,
  ProviderInfo as DomainProviderInfo,
  ReasoningLevel,
  RuntimePermissionPolicy,
  ServiceTier,
  ThreadEvent,
  ToolCallRequest,
  ToolCallResponse,
} from "@bb/domain";
import type { AgentRuntimeCaptureEntry } from "./capture-types.js";

export type ProviderInfo = DomainProviderInfo;

export type AgentRuntimeShellEnvironment = Record<string, string>;

export type AgentRuntimeExecutionOptions = {
  model?: string;
  serviceTier?: ServiceTier;
  reasoningLevel?: ReasoningLevel;
} & RuntimePermissionPolicy;

// ---------------------------------------------------------------------------
// Runtime options
// ---------------------------------------------------------------------------

export interface AgentRuntimeOptions {
  /** Working directory for provider processes. */
  workspacePath: string;

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
  onProcessExit?: (info: {
    providerId: string;
    threadIds: string[];
    code: number | null;
    signal: string | null;
  }) => void;

  /**
   * Optional factory for creating provider adapters.
   * Used for testing with fake adapters.
   * If not provided, the built-in adapter registry is used.
   */
  adapterFactory?: (providerId: string) => import("./provider-adapter.js").ProviderAdapter;
}

// ---------------------------------------------------------------------------
// Runtime interface
// ---------------------------------------------------------------------------

export interface AgentRuntime {
  ensureProvider(args: {
    providerId: string;
    forThreadId?: string;
  }): Promise<void>;

  startThread(args: {
    environmentId: string;
    threadId: string;
    projectId: string;
    providerId?: string;
    input?: PromptInput[];
    options: AgentRuntimeExecutionOptions;
    instructions?: string;
    dynamicTools?: DynamicTool[];
    instructionMode?: InstructionMode;
  }): Promise<{ providerThreadId: string }>;

  resumeThread(args: {
    environmentId: string;
    threadId: string;
    projectId?: string;
    providerThreadId?: string;
    providerId?: string;
    options: AgentRuntimeExecutionOptions;
    instructions?: string;
    resumePath?: string;
    dynamicTools?: DynamicTool[];
    instructionMode?: InstructionMode;
  }): Promise<{ providerThreadId: string }>;

  runTurn(args: {
    threadId: string;
    input: PromptInput[];
    clientRequestSequence?: number;
    options: AgentRuntimeExecutionOptions;
    instructions?: string;
  }): Promise<void>;

  steerTurn(args: {
    threadId: string;
    expectedTurnId: string;
    input: PromptInput[];
    clientRequestSequence?: number;
    options: AgentRuntimeExecutionOptions;
    instructions?: string;
  }): Promise<void>;

  stopThread(args: { threadId: string }): Promise<void>;

  renameThread(args: {
    threadId: string;
    title: string;
  }): Promise<void>;

  listModels(args: { providerId: string }): Promise<AvailableModel[]>;

  listRunningProviders(): string[];

  shutdown(): Promise<void>;
}
