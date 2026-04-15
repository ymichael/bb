import type {
  AvailableModel,
  DynamicTool,
  InstructionMode,
  PendingInteractionPayload,
  PendingInteractionResolution,
  PromptInput,
  ProviderCapabilities,
  ReasoningLevel,
  RuntimePermissionPolicy,
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

export type JsonValue =
  | boolean
  | number
  | string
  | null
  | JsonValue[]
  | { [key: string]: JsonValue | undefined };

export const JSON_RPC_INVALID_PARAMS_CODE = -32602;

export class ProviderRequestDecodeError extends Error {
  readonly code = JSON_RPC_INVALID_PARAMS_CODE;

  constructor(message: string) {
    super(message);
    this.name = "ProviderRequestDecodeError";
  }
}

export class ProviderResponseEncodeError extends Error {
  readonly code = JSON_RPC_INVALID_PARAMS_CODE;

  constructor(message: string) {
    super(message);
    this.name = "ProviderResponseEncodeError";
  }
}

export interface ProviderTranslationContext {
  threadId?: string;
  parentToolCallId?: string;
}

export interface ProviderAcceptedCommandTranslationArgs {
  command: AdapterCommand;
}

export interface ProviderAdapterFactoryOptions {
  bridgeBundleDir?: string;
  turnIdPrefix?: string;
}

export type ProviderThreadStopBehavior = "keep-provider" | "restart-provider";

export interface DecodedToolCallRequest {
  requestId: string | number;
  providerThreadId: string;
  turnId: string;
  callId: string;
  tool: string;
  arguments?: unknown;
  threadId?: string;
}

export interface DecodedInteractiveRequest {
  requestId: string | number;
  method: string;
  providerThreadId: string;
  turnId: string;
  payload: PendingInteractionPayload;
  threadId?: string;
}

// ---------------------------------------------------------------------------
// AdapterCommand — what the runtime asks the adapter to build
// ---------------------------------------------------------------------------

export type AdapterOptions = {
  model?: string;
  serviceTier?: ServiceTier;
  reasoningLevel?: ReasoningLevel;
  instructions?: string;
  envVars?: Record<string, string>;
} & RuntimePermissionPolicy;

export type AdapterCommand =
  | { type: "initialize" }
  | { type: "model/list" }
  | {
      type: "thread/start";
      threadId: string;
      cwd: string;
      input?: PromptInput[];
      options: AdapterOptions;
      dynamicTools?: DynamicTool[];
      instructionMode: InstructionMode;
    }
  | {
      type: "thread/resume";
      threadId: string;
      cwd: string;
      providerThreadId?: string;
      options: AdapterOptions;
      resumePath?: string;
      dynamicTools?: DynamicTool[];
      instructionMode: InstructionMode;
    }
  | {
      type: "turn/start";
      threadId: string;
      providerThreadId?: string;
      input: PromptInput[];
      clientRequestSequence?: number;
      options: AdapterOptions;
    }
  | {
      type: "turn/steer";
      threadId: string;
      providerThreadId?: string;
      expectedTurnId: string;
      input: PromptInput[];
      clientRequestSequence?: number;
      options: AdapterOptions;
    }
  | {
      type: "thread/stop";
      threadId: string;
      providerThreadId: string;
      activeTurnId: string | null;
    }
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
  threadStopBehavior: ProviderThreadStopBehavior;
  process: { command: string; args: string[] };

  buildCommand(command: AdapterCommand): JsonRpcMessage | null;
  parseModelListResult(result: unknown): AvailableModel[];
  translateEvent(
    event: unknown,
    context?: ProviderTranslationContext,
  ): ThreadEvent[];
  /**
   * Returns normalized events implied by a successful provider command.
   * Use this for provider protocol gaps where accepted commands do not produce
   * their own notifications, such as accepted user input missing a userMessage.
   */
  translateAcceptedCommand(args: ProviderAcceptedCommandTranslationArgs): ThreadEvent[];
  decodeToolCallRequest(request: JsonRpcMessage): DecodedToolCallRequest | null;
  decodeInteractiveRequest?(request: JsonRpcMessage): DecodedInteractiveRequest | null;
  buildInteractiveResponse?(args: BuildInteractiveResponseArgs): JsonValue;
}

export interface BuildInteractiveResponseArgs {
  request: DecodedInteractiveRequest;
  resolution: PendingInteractionResolution;
}
