/**
 * Shared tool call helpers for bridge processes.
 *
 * Both claude-code and pi bridges forward tool calls from the provider SDK
 * to the host-daemon and feed responses back. This module provides:
 * - The JSON-RPC request type for forwarding tool calls
 * - Response decoding for tool call results from the host-daemon
 * - Generic JSON-RPC response decoding (for matching tool call responses)
 */

import { z } from "zod";
import { providerToolCallResponseSchema } from "./provider-tool-call-contract.js";

// ---------------------------------------------------------------------------
// Tool call request — bridge → host-daemon
// ---------------------------------------------------------------------------

export interface BridgeToolCallRequest {
  jsonrpc: "2.0";
  id: string | number;
  method: "item/tool/call";
  params: {
    threadId: string;
    turnId: string;
    callId: string;
    tool: string;
    arguments: Record<string, unknown>;
  };
}

// ---------------------------------------------------------------------------
// JSON-RPC envelope schema — shared by both bridges for request decoding
// ---------------------------------------------------------------------------

export const jsonRpcEnvelopeSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number()]),
  method: z.string(),
  params: z.record(z.string(), z.unknown()).optional(),
});

// ---------------------------------------------------------------------------
// JSON-RPC response decoding — host-daemon → bridge
// ---------------------------------------------------------------------------

const jsonRpcErrorSchema = z.object({
  code: z.number(),
  message: z.string().optional(),
  data: z.unknown().optional(),
});

const jsonRpcSuccessResponseSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number()]),
  result: z.unknown(),
});

const jsonRpcErrorResponseSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number()]),
  error: jsonRpcErrorSchema,
});

export type BridgeJsonRpcResponse =
  | z.infer<typeof jsonRpcSuccessResponseSchema>
  | z.infer<typeof jsonRpcErrorResponseSchema>;

export function decodeBridgeJsonRpcResponse(input: unknown): BridgeJsonRpcResponse | null {
  const error = jsonRpcErrorResponseSchema.safeParse(input);
  if (error.success) return error.data;

  const success = jsonRpcSuccessResponseSchema.safeParse(input);
  return success.success ? success.data : null;
}

// ---------------------------------------------------------------------------
// Tool call response payload decoding
// ---------------------------------------------------------------------------

export function decodeToolCallResponsePayload(result: unknown): {
  content: string;
  isError: boolean;
} {
  const parsed = providerToolCallResponseSchema.safeParse(result);
  if (!parsed.success) {
    return { content: "OK", isError: false };
  }

  const text = parsed.data.contentItems
    .filter((item) => item.type === "inputText")
    .map((item) => (item as { type: "inputText"; text: string }).text)
    .join("\n");

  return {
    content: text || "OK",
    isError: !parsed.data.success,
  };
}
