import type {
  PendingInteractionCreate,
  PendingInteractionResolution,
  ThreadEvent,
  ToolCallRequest,
  ToolCallResponse,
} from "@bb/domain";
import type { JsonRpcMessage } from "./runtime-json-rpc.js";

interface AgentRuntimeCaptureEntryBase {
  capturedAt: number;
  providerId: string;
}

export interface AgentRuntimeRawProviderEventCaptureEntry
  extends AgentRuntimeCaptureEntryBase {
  kind: "raw-provider-event";
  captureId: string;
  rawLine: string;
  rawEvent: JsonRpcMessage;
  sourceThreadId?: string;
}

export interface AgentRuntimeTranslatedThreadEventCaptureEntry
  extends AgentRuntimeCaptureEntryBase {
  kind: "translated-thread-event";
  rawCaptureId?: string;
  rawMethod?: string;
  event: ThreadEvent;
}

export interface AgentRuntimeToolCallRequestCaptureEntry
  extends AgentRuntimeCaptureEntryBase {
  kind: "tool-call-request";
  captureId: string;
  rawLine: string;
  rawRequest: JsonRpcMessage;
  request: ToolCallRequest;
}

export interface AgentRuntimeToolCallResultCaptureEntry
  extends AgentRuntimeCaptureEntryBase {
  kind: "tool-call-result";
  requestCaptureId?: string;
  requestId: string | number;
  success: boolean;
  response?: ToolCallResponse;
  errorMessage?: string;
}

export interface AgentRuntimeInteractiveRequestCaptureEntry
  extends AgentRuntimeCaptureEntryBase {
  kind: "interactive-request";
  captureId: string;
  rawLine: string;
  rawRequest: JsonRpcMessage;
  request: PendingInteractionCreate;
}

export interface AgentRuntimeInteractiveResultCaptureEntry
  extends AgentRuntimeCaptureEntryBase {
  kind: "interactive-result";
  requestCaptureId?: string;
  requestId: string;
  success: boolean;
  resolution?: PendingInteractionResolution;
  errorMessage?: string;
}

export interface AgentRuntimeProviderStderrCaptureEntry
  extends AgentRuntimeCaptureEntryBase {
  kind: "provider-stderr";
  line: string;
  threadId?: string;
}

export interface AgentRuntimeProviderProcessErrorCaptureEntry
  extends AgentRuntimeCaptureEntryBase {
  kind: "provider-process-error";
  message: string;
}

export interface AgentRuntimeProviderProcessExitCaptureEntry
  extends AgentRuntimeCaptureEntryBase {
  kind: "provider-process-exit";
  threadIds: string[];
  code: number | null;
  signal: string | null;
  stderrChunks: string[];
}

export type AgentRuntimeCaptureEntry =
  | AgentRuntimeRawProviderEventCaptureEntry
  | AgentRuntimeTranslatedThreadEventCaptureEntry
  | AgentRuntimeToolCallRequestCaptureEntry
  | AgentRuntimeToolCallResultCaptureEntry
  | AgentRuntimeInteractiveRequestCaptureEntry
  | AgentRuntimeInteractiveResultCaptureEntry
  | AgentRuntimeProviderStderrCaptureEntry
  | AgentRuntimeProviderProcessErrorCaptureEntry
  | AgentRuntimeProviderProcessExitCaptureEntry;
