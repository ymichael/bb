import type {
  AvailableModel,
  PromptInput,
  ProviderCapabilities,
  SpawnThreadRequest,
  Thread,
  ThreadEvent,
  ThreadEventOfType,
  ThreadProviderId,
} from "@bb/core";
import type { ReasoningLevel, SandboxMode, ServiceTier } from "@bb/core";

export interface ProviderExecutionOptions {
  model?: string;
  serviceTier?: ServiceTier;
  reasoningLevel?: ReasoningLevel;
  sandboxMode?: SandboxMode;
}

export interface ProviderThreadContext {
  projectId: string;
  threadId: string;
  serverUrl?: string;
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
  preflightSessionStart?():
    | string
    | undefined
    | Promise<string | undefined>;
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
    providerThreadId: string | undefined,
    context: ProviderThreadContext,
    options?: ProviderExecutionOptions,
    resumePath?: string,
  ): Record<string, unknown>;
  createTurnStartParams(
    threadId: string,
    providerThreadId: string | undefined,
    input: PromptInput[],
    options?: ProviderExecutionOptions,
  ): Record<string, unknown>;
  createTurnSteerParams?(
    threadId: string,
    providerThreadId: string | undefined,
    expectedTurnId: string,
    input: PromptInput[],
  ): Record<string, unknown>;
  createThreadNameSetParams?(
    threadId: string,
    providerThreadId: string | undefined,
    title: string,
  ): Record<string, unknown>;
  extractThreadIdFromResult(result: unknown): string | undefined;
  extractThreadIdFromEventData(data: unknown): string | undefined;
  normalizeEventType(type: string): string;
  shouldPersistEvent?(method: string, data: unknown): boolean;
  shouldBroadcastForEvent(method: string): boolean;
  statusForEvent(method: string, data: unknown): Thread["status"] | undefined;
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
