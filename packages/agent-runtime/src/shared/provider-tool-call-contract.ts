import { z } from "zod";
import type { DecodedToolCallRequest } from "../provider-adapter.js";

const providerToolCallRequestSchema = z.object({
  threadId: z.string(),
  providerThreadId: z.string().optional(),
  turnId: z.string(),
  callId: z.string().min(1),
  tool: z.string().min(1),
  arguments: z.unknown(),
});

export const providerToolCallResponseSchema = z.object({
  success: z.boolean(),
  contentItems: z.array(
    z.discriminatedUnion("type", [
      z.object({
        type: z.literal("inputText"),
        text: z.string(),
      }),
      z.object({
        type: z.literal("inputImage"),
        imageUrl: z.string().min(1),
      }),
    ]),
  ),
});

export function decodeProviderToolCallRequest(
  requestId: string | number,
  method: string,
  params: unknown,
): DecodedToolCallRequest | null {
  if (method !== "item/tool/call") {
    return null;
  }

  const parsed = providerToolCallRequestSchema.safeParse(params);
  if (!parsed.success) {
    return null;
  }

  const providerThreadId = parsed.data.providerThreadId ?? parsed.data.threadId;
  return {
    requestId,
    providerThreadId,
    turnId: parsed.data.turnId,
    callId: parsed.data.callId,
    tool: parsed.data.tool,
    ...(parsed.data.arguments !== undefined ? { arguments: parsed.data.arguments } : {}),
    ...(parsed.data.providerThreadId ? { threadId: parsed.data.threadId } : {}),
  };
}
