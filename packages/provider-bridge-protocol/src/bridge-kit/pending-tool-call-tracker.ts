import {
  decodeToolCallResponsePayload,
  type BridgeJsonRpcResponse,
  type BridgeToolCallContent,
  type BridgeToolCallImage,
  type BridgeToolCallRequest,
} from "./bridge-tool-calls.js";

export interface BridgeToolCallResult {
  content: string;
  contentBlocks?: BridgeToolCallContent[];
  images?: BridgeToolCallImage[];
  isError?: boolean;
}

interface PendingToolCall {
  resolve: (value: BridgeToolCallResult) => void;
  scope: object;
}

export interface ForwardBridgeToolCallArgs {
  arguments: Record<string, unknown>;
  providerThreadId: string;
  scope: object;
  threadId: string;
  toolName: string;
}

export interface PendingToolCallTracker {
  forwardToolCall: (
    args: ForwardBridgeToolCallArgs,
  ) => Promise<BridgeToolCallResult>;
  handleToolCallResponse: (response: BridgeJsonRpcResponse) => boolean;
  resolvePendingToolCalls: (scope: object, message: string) => void;
}

export function createPendingToolCallTracker(options: {
  sendToolCall: (request: BridgeToolCallRequest) => void;
}): PendingToolCallTracker {
  const pendingToolCalls = new Map<string | number, PendingToolCall>();
  let requestIdCounter = 0;

  return {
    forwardToolCall: (args) => {
      return new Promise<BridgeToolCallResult>((resolve) => {
        requestIdCounter += 1;
        const requestId = requestIdCounter;
        pendingToolCalls.set(requestId, { resolve, scope: args.scope });
        try {
          options.sendToolCall({
            jsonrpc: "2.0",
            id: requestId,
            method: "item/tool/call",
            params: {
              threadId: args.threadId,
              providerThreadId: args.providerThreadId,
              turnId: null,
              callId: `call-${requestId}`,
              tool: args.toolName,
              arguments: args.arguments,
            },
          });
        } catch (error) {
          pendingToolCalls.delete(requestId);
          resolve({
            content: error instanceof Error ? error.message : String(error),
            isError: true,
          });
        }
      });
    },
    handleToolCallResponse: (response) => {
      const pending = pendingToolCalls.get(response.id);
      if (!pending) {
        return false;
      }
      pendingToolCalls.delete(response.id);
      if ("error" in response) {
        pending.resolve({
          content: response.error.message ?? "Tool call failed",
          isError: true,
        });
      } else {
        pending.resolve(decodeToolCallResponsePayload(response.result));
      }
      return true;
    },
    resolvePendingToolCalls: (scope, message) => {
      for (const [requestId, pending] of pendingToolCalls) {
        if (pending.scope !== scope) {
          continue;
        }
        pendingToolCalls.delete(requestId);
        pending.resolve({ content: message, isError: true });
      }
    },
  };
}
