import type { ChildProcess } from "node:child_process";
import type {
  AgentRuntimeExecutionOptions,
  AgentRuntimeOptions,
} from "./types.js";
import type {
  PendingInteractionCreate,
  PendingInteractionPayload,
  PendingInteractionResolution,
  ToolCallRequest,
} from "@bb/domain";
import type { AgentRuntimeCaptureEntry } from "./capture-types.js";
import type {
  ProviderAdapter,
} from "./provider-adapter.js";
import {
  type JsonRpcMessage,
  ProviderResponseEncodeError,
  sendJsonRpcError,
  sendJsonRpcResult,
  sendProviderRequestDecodeErrorIfKnown,
  sendProviderResponseEncodeErrorIfKnown,
} from "./runtime-json-rpc.js";
import { shouldAutoDenyInteractiveRequest } from "./shared/permission-policy.js";

export type RuntimeProviderRequestKind = "interactive request" | "tool call";

export interface RuntimeProviderRequestProcess {
  adapter: ProviderAdapter;
  child: ChildProcess;
  interactiveRequestScope: string;
}

export interface ResolveRuntimeProviderRequestThreadIdArgs {
  parsedId: string | number;
  providerThreadId: string;
  requestKind: RuntimeProviderRequestKind;
  threadIdHint: string | undefined;
}

export interface RuntimeProviderRequestArgs {
  line: string;
  parsedId: string | number;
  parsedMethod: string;
  providerProcess: RuntimeProviderRequestProcess;
  rawRequest: JsonRpcMessage;
}

export interface HandleRuntimeProviderRequestArgs extends RuntimeProviderRequestArgs {
  createCaptureId: () => string;
  emitCapture: (entry: AgentRuntimeCaptureEntry) => void;
  getThreadExecutionOptions: (
    threadId: string,
  ) => AgentRuntimeExecutionOptions | undefined;
  onInteractiveRequest: AgentRuntimeOptions["onInteractiveRequest"];
  onToolCall: AgentRuntimeOptions["onToolCall"];
  resolveThreadId: (
    args: ResolveRuntimeProviderRequestThreadIdArgs,
  ) => string | null;
}

function scopeProviderRequestId(
  scope: string,
  requestId: string | number,
): string {
  return `${scope}:${String(requestId)}`;
}

function buildDeniedInteractiveResolution(
  payload: PendingInteractionPayload,
): PendingInteractionResolution {
  if (!payload.availableDecisions.includes("deny")) {
    throw new ProviderResponseEncodeError(
      "Interactive request cannot be auto-denied because deny is unavailable",
    );
  }
  return {
    decision: "deny",
  };
}

function handleToolCallProviderRequest(
  args: HandleRuntimeProviderRequestArgs,
): boolean {
  const providerId = args.providerProcess.adapter.id;
  let toolCallReq: ReturnType<ProviderAdapter["decodeToolCallRequest"]>;
  try {
    toolCallReq = args.providerProcess.adapter.decodeToolCallRequest(args.rawRequest);
  } catch (error) {
    if (sendProviderRequestDecodeErrorIfKnown({
      child: args.providerProcess.child,
      error,
      id: args.parsedId,
    })) {
      return true;
    }
    throw error;
  }
  if (!toolCallReq) {
    return false;
  }

  const resolvedThreadId = args.resolveThreadId({
    parsedId: args.parsedId,
    providerThreadId: toolCallReq.providerThreadId,
    requestKind: "tool call",
    threadIdHint: toolCallReq.threadId,
  });
  if (!resolvedThreadId) {
    return true;
  }

  const scopedToolCallReq: ToolCallRequest = {
    requestId: toolCallReq.requestId,
    threadId: resolvedThreadId,
    providerThreadId: toolCallReq.providerThreadId,
    turnId: toolCallReq.turnId,
    callId: toolCallReq.callId,
    tool: toolCallReq.tool,
    ...(toolCallReq.arguments !== undefined ? { arguments: toolCallReq.arguments } : {}),
  };
  const captureId = args.createCaptureId();
  args.emitCapture({
    kind: "tool-call-request",
    captureId,
    capturedAt: Date.now(),
    providerId,
    rawLine: args.line,
    rawRequest: args.rawRequest,
    request: scopedToolCallReq,
  });
  void args.onToolCall(scopedToolCallReq).then((response) => {
    args.emitCapture({
      kind: "tool-call-result",
      capturedAt: Date.now(),
      providerId,
      requestCaptureId: captureId,
      requestId: scopedToolCallReq.requestId,
      success: true,
      response,
    });
    sendJsonRpcResult({
      child: args.providerProcess.child,
      id: args.parsedId,
      result: response,
    });
  }).catch((err) => {
    args.emitCapture({
      kind: "tool-call-result",
      capturedAt: Date.now(),
      providerId,
      requestCaptureId: captureId,
      requestId: scopedToolCallReq.requestId,
      success: false,
      errorMessage: err instanceof Error ? err.message : String(err),
    });
    sendJsonRpcError({
      child: args.providerProcess.child,
      id: args.parsedId,
      message: err instanceof Error ? err.message : String(err),
    });
  });
  return true;
}

function handleInteractiveProviderRequest(
  args: HandleRuntimeProviderRequestArgs,
): boolean {
  const providerId = args.providerProcess.adapter.id;
  const decodeInteractiveRequest = args.providerProcess.adapter.decodeInteractiveRequest;
  if (!decodeInteractiveRequest) {
    return false;
  }

  let interactiveReq: ReturnType<typeof decodeInteractiveRequest>;
  try {
    interactiveReq = decodeInteractiveRequest(args.rawRequest);
  } catch (error) {
    if (sendProviderRequestDecodeErrorIfKnown({
      child: args.providerProcess.child,
      error,
      id: args.parsedId,
    })) {
      return true;
    }
    throw error;
  }
  if (!interactiveReq) {
    return false;
  }

  const resolvedThreadId = args.resolveThreadId({
    parsedId: args.parsedId,
    providerThreadId: interactiveReq.providerThreadId,
    requestKind: "interactive request",
    threadIdHint: interactiveReq.threadId,
  });
  if (!resolvedThreadId) {
    return true;
  }
  if (!args.providerProcess.adapter.buildInteractiveResponse) {
    sendJsonRpcError({
      child: args.providerProcess.child,
      id: args.parsedId,
      message: `Provider "${providerId}" cannot encode interactive response for "${interactiveReq.method}"`,
    });
    return true;
  }
  const buildInteractiveResponse = args.providerProcess.adapter.buildInteractiveResponse;

  const scopedInteractiveReq: PendingInteractionCreate = {
    threadId: resolvedThreadId,
    turnId: interactiveReq.turnId,
    providerId,
    providerThreadId: interactiveReq.providerThreadId,
    providerRequestId: scopeProviderRequestId(
      args.providerProcess.interactiveRequestScope,
      interactiveReq.requestId,
    ),
    payload: interactiveReq.payload,
  };
  const captureId = args.createCaptureId();
  args.emitCapture({
    kind: "interactive-request",
    captureId,
    capturedAt: Date.now(),
    providerId,
    rawLine: args.line,
    rawRequest: args.rawRequest,
    request: scopedInteractiveReq,
  });

  const executionOptions = args.getThreadExecutionOptions(resolvedThreadId);
  if (
    (executionOptions
      ? shouldAutoDenyInteractiveRequest(executionOptions)
      : false)
    || !args.onInteractiveRequest
  ) {
    try {
      const resolution = buildDeniedInteractiveResolution(interactiveReq.payload);
      const result = buildInteractiveResponse({
        request: interactiveReq,
        resolution,
      });
      args.emitCapture({
        kind: "interactive-result",
        capturedAt: Date.now(),
        providerId,
        requestCaptureId: captureId,
        requestId: scopedInteractiveReq.providerRequestId,
        success: true,
        resolution,
      });
      sendJsonRpcResult({
        child: args.providerProcess.child,
        id: args.parsedId,
        result,
      });
    } catch (error) {
      args.emitCapture({
        kind: "interactive-result",
        capturedAt: Date.now(),
        providerId,
        requestCaptureId: captureId,
        requestId: scopedInteractiveReq.providerRequestId,
        success: false,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      if (
        sendProviderResponseEncodeErrorIfKnown({
          child: args.providerProcess.child,
          error,
          id: args.parsedId,
        })
      ) {
        return true;
      }
      sendJsonRpcError({
        child: args.providerProcess.child,
        id: args.parsedId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
    return true;
  }

  void args.onInteractiveRequest(scopedInteractiveReq).then((resolution) => {
    args.emitCapture({
      kind: "interactive-result",
      capturedAt: Date.now(),
      providerId,
      requestCaptureId: captureId,
      requestId: scopedInteractiveReq.providerRequestId,
      success: true,
      resolution,
    });
    const result = buildInteractiveResponse({
      request: interactiveReq,
      resolution,
    });
    sendJsonRpcResult({
      child: args.providerProcess.child,
      id: args.parsedId,
      result,
    });
  }).catch((err) => {
    args.emitCapture({
      kind: "interactive-result",
      capturedAt: Date.now(),
      providerId,
      requestCaptureId: captureId,
      requestId: scopedInteractiveReq.providerRequestId,
      success: false,
      errorMessage: err instanceof Error ? err.message : String(err),
    });
    if (
      sendProviderResponseEncodeErrorIfKnown({
        child: args.providerProcess.child,
        error: err,
        id: args.parsedId,
      })
    ) {
      return;
    }
    sendJsonRpcError({
      child: args.providerProcess.child,
      id: args.parsedId,
      message: err instanceof Error ? err.message : String(err),
    });
  });
  return true;
}

export function handleRuntimeProviderRequest(
  args: HandleRuntimeProviderRequestArgs,
): void {
  if (handleToolCallProviderRequest(args)) {
    return;
  }
  if (handleInteractiveProviderRequest(args)) {
    return;
  }

  sendJsonRpcError({
    child: args.providerProcess.child,
    id: args.parsedId,
    message: `Unsupported provider request "${args.parsedMethod}"`,
    code: -32601,
  });
}
