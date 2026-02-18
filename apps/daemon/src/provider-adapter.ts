import type {
  AvailableModel,
  ProviderCapabilities,
  PromptInput,
  ReasoningLevel,
  SandboxMode,
  SpawnThreadRequest,
  Thread,
  ThreadEvent,
} from "@beanbag/core";

export interface ProviderExecutionOptions {
  model?: string;
  reasoningLevel?: ReasoningLevel;
  sandboxMode?: SandboxMode;
}

export interface ProviderTitleGeneratorArgs {
  input: PromptInput[];
  cwd: string;
}

export type ProviderTitleGenerator = (
  args: ProviderTitleGeneratorArgs,
) => Promise<string | undefined>;

export interface ProviderThreadContext {
  projectId: string;
  threadId: string;
  taskId?: string;
  path?: string;
}

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
  inactiveSessionErrorMessage(threadId: string): string;
}
