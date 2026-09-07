import type {
  PendingInteractionPayload,
  PendingInteractionResolution,
} from "@bb/domain";

export interface ProviderRequestCommandPlan {
  kind: "request";
  method: string;
  params?: object;
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

export interface ProviderPostInitializeRequest {
  plan: ProviderRequestCommandPlan;
  required: boolean;
  onResult(result: unknown): void;
}

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
  turnId: string | null;
  callId: string;
  tool: string;
  arguments?: unknown;
  threadId?: string;
}

export interface DecodedInteractiveRequest {
  requestId: string | number;
  method: string;
  providerThreadId: string;
  turnId: string | null;
  payload: PendingInteractionPayload;
  threadId?: string;
}

export interface PreparedProviderCommandDispatch {
  rollback(): void;
  claim(): boolean;
}

export interface BuildInteractiveResponseArgs {
  request: DecodedInteractiveRequest;
  resolution: PendingInteractionResolution;
}
