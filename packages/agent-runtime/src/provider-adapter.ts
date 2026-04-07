import type {
  AvailableModel,
  DynamicTool,
  PromptInput,
  ProviderCapabilities,
  ReasoningLevel,
  SandboxMode,
  ServiceTier,
  ThreadEvent,
} from "@bb/domain";

// ---------------------------------------------------------------------------
// JSON-RPC 2.0 message
// ---------------------------------------------------------------------------

export interface JsonRpcMessage {
  jsonrpc: "2.0";
  id?: string | number;
  method: string;
  params?: unknown;
}

export interface ProviderTranslationContext {
  threadId?: string;
  parentToolCallId?: string;
}

export interface ProviderAdapterFactoryOptions {
  bridgeBundleDir?: string;
}

export interface DecodedToolCallRequest {
  requestId: string | number;
  providerThreadId: string;
  turnId: string;
  callId: string;
  tool: string;
  arguments?: unknown;
  threadId?: string;
}

// ---------------------------------------------------------------------------
// AdapterCommand — what the runtime asks the adapter to build
// ---------------------------------------------------------------------------

export interface AdapterOptions {
  model?: string;
  serviceTier?: ServiceTier;
  reasoningLevel?: ReasoningLevel;
  sandboxMode?: SandboxMode;
  instructions?: string;
  envVars?: Record<string, string>;
}

export type AdapterCommand =
  | { type: "initialize" }
  | { type: "model/list" }
  | {
      type: "thread/start";
      threadId: string;
      input?: PromptInput[];
      options?: AdapterOptions;
      dynamicTools?: DynamicTool[];
    }
  | {
      type: "thread/resume";
      threadId: string;
      providerThreadId?: string;
      options?: AdapterOptions;
      resumePath?: string;
      dynamicTools?: DynamicTool[];
    }
  | {
      type: "turn/start";
      threadId: string;
      providerThreadId?: string;
      input: PromptInput[];
      options?: AdapterOptions;
    }
  | {
      type: "turn/steer";
      threadId: string;
      providerThreadId?: string;
      expectedTurnId: string;
      input: PromptInput[];
      options?: AdapterOptions;
    }
  | { type: "thread/stop"; threadId: string }
  | {
      type: "thread/name/set";
      threadId: string;
      providerThreadId?: string;
      title: string;
    };

// ---------------------------------------------------------------------------
// ProviderAdapter — internal extension contract
// ---------------------------------------------------------------------------

export interface ProviderAdapter {
  id: string;
  displayName: string;
  capabilities: ProviderCapabilities;
  process: { command: string; args: string[] };

  buildCommand(command: AdapterCommand): JsonRpcMessage | null;
  parseModelListResult(result: unknown): AvailableModel[];
  translateEvent(
    event: unknown,
    context?: ProviderTranslationContext,
  ): ThreadEvent[];
  decodeToolCallRequest(request: JsonRpcMessage): DecodedToolCallRequest | null;
}
