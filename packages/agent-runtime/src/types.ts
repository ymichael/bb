import type {
  AvailableModel,
  DynamicTool,
  PromptInput,
  ProviderCapabilities,
  ThreadEvent,
  ThreadExecutionOptions,
  ToolCallRequest,
  ToolCallResponse,
} from "@bb/domain";
import type { AgentRuntimeCaptureEntry } from "./capture-types.js";

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

export interface ProviderInfo {
  id: string;
  displayName: string;
  capabilities: ProviderCapabilities;
  available: boolean;
}

// ---------------------------------------------------------------------------
// Runtime options
// ---------------------------------------------------------------------------

export interface AgentRuntimeOptions {
  /** Working directory for provider processes. */
  workspacePath: string;

  /** Environment variables passed to ALL provider processes. */
  env?: Record<string, string>;

  /** Called when a provider emits a translated event.
   *  Every event has `threadId` (bb ID) and `providerThreadId` (provider's internal ID). */
  onEvent: (event: ThreadEvent) => void;

  /** Called when runtime audit capture is enabled by a harness or test. */
  onCapture?: (entry: AgentRuntimeCaptureEntry) => void;

  /** Called when a provider needs to execute a tool. */
  onToolCall: (request: ToolCallRequest) => Promise<ToolCallResponse>;

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
    threadId: string;
    projectId: string;
    providerId?: string;
    input?: PromptInput[];
    options?: ThreadExecutionOptions;
    instructions?: string;
    dynamicTools?: DynamicTool[];
  }): Promise<{ providerThreadId: string }>;

  resumeThread(args: {
    threadId: string;
    projectId?: string;
    providerThreadId?: string;
    providerId?: string;
    options?: ThreadExecutionOptions;
    instructions?: string;
    resumePath?: string;
    dynamicTools?: DynamicTool[];
  }): Promise<{ providerThreadId: string }>;

  runTurn(args: {
    threadId: string;
    input: PromptInput[];
    options?: ThreadExecutionOptions;
    instructions?: string;
  }): Promise<void>;

  steerTurn(args: {
    threadId: string;
    expectedTurnId: string;
    input: PromptInput[];
    options?: ThreadExecutionOptions;
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
