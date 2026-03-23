import { z } from "zod";
import type {
  ToolCallRequest,
} from "@bb/domain";

const providerToolCallRequestSchema = z.object({
  threadId: z.string(),
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
): ToolCallRequest | null {
  if (method !== "item/tool/call") {
    return null;
  }

  const parsed = providerToolCallRequestSchema.safeParse(params);
  if (!parsed.success) {
    return null;
  }

  return {
    requestId,
    ...parsed.data,
  };
}
