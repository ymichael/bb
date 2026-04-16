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
import type {
  ProviderInboundRequest,
  ProviderRuntimeEvent,
} from "./runtime-json-rpc.js";

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

export type ProviderAdapterFactory = (providerId: string) => ProviderAdapter;

export type ProviderCommandProcessEffect = "restart-provider";

export interface ProviderRequestCommandPlan {
  kind: "request";
  method: string;
  params?: object;
  processEffect?: ProviderCommandProcessEffect;
}

export interface ProviderNoopCommandPlan {
  kind: "noop";
  method?: never;
  params?: never;
  reason: string;
}

export type ProviderCommandPlan =
  | ProviderRequestCommandPlan
  | ProviderNoopCommandPlan;

export type ProviderInteractiveResponse =
  | boolean
  | number
  | string
  | null
  | ProviderInteractiveResponse[]
  | { [key: string]: ProviderInteractiveResponse | undefined };

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

export type ProviderExecutionContext = {
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
      options: ProviderExecutionContext;
      dynamicTools?: DynamicTool[];
      instructionMode: InstructionMode;
    }
  | {
      type: "thread/resume";
      threadId: string;
      cwd: string;
      providerThreadId?: string;
      options: ProviderExecutionContext;
      dynamicTools?: DynamicTool[];
      instructionMode: InstructionMode;
    }
  | {
      type: "turn/start";
      threadId: string;
      providerThreadId?: string;
      input: PromptInput[];
      clientRequestSequence?: number;
      options: ProviderExecutionContext;
    }
  | {
      type: "turn/steer";
      threadId: string;
      providerThreadId?: string;
      expectedTurnId: string;
      input: PromptInput[];
      clientRequestSequence?: number;
      options: ProviderExecutionContext;
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

export type TurnStartAdapterCommand = Extract<AdapterCommand, { type: "turn/start" }>;

export interface PreparedProviderCommandDispatch {
  rollback(): void;
}

export function noPreparedProviderCommandDispatch(
  _command: TurnStartAdapterCommand,
): null {
  return null;
}

// ---------------------------------------------------------------------------
// ProviderAdapter — internal extension contract
// ---------------------------------------------------------------------------

export interface ProviderAdapter {
  id: string;
  displayName: string;
  capabilities: ProviderCapabilities;
  process: { command: string; args: string[] };

  buildCommandPlan(command: AdapterCommand): ProviderCommandPlan;
  /**
   * Called immediately before a turn/start request is sent. Some providers
   * emit turn/started before the request promise resolves, so adapters that
   * need command-to-event correlation must prepare that state before dispatch.
   */
  prepareTurnStart(
    command: TurnStartAdapterCommand,
  ): PreparedProviderCommandDispatch | null;
  parseModelListResult(result: unknown): AvailableModel[];
  translateEvent(
    event: ProviderRuntimeEvent,
    context?: ProviderTranslationContext,
  ): ThreadEvent[];
  /**
   * Returns normalized events implied by a successful provider command.
   * Use this for provider protocol gaps where accepted commands do not produce
   * their own notifications, such as accepted user input missing a userMessage.
   */
  translateAcceptedCommand(args: ProviderAcceptedCommandTranslationArgs): ThreadEvent[];
  decodeToolCallRequest(request: ProviderInboundRequest): DecodedToolCallRequest | null;
  decodeInteractiveRequest?(request: ProviderInboundRequest): DecodedInteractiveRequest | null;
  buildInteractiveResponse?(args: BuildInteractiveResponseArgs): ProviderInteractiveResponse;
}

export interface BuildInteractiveResponseArgs {
  request: DecodedInteractiveRequest;
  resolution: PendingInteractionResolution;
}
