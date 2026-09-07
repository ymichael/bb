import { pendingInteractionPayloadSchema } from "@bb/domain";
import { z } from "zod";

export const BRIDGE_INBOUND_REQUEST_METHODS = {
  toolCall: "item/tool/call",
  interactionRequest: "interaction/request",
} as const;

export const toolCallRequestParamsSchema = z
  .object({
    providerThreadId: z.string().min(1),
    threadId: z.string().min(1).optional(),
    turnId: z.union([z.string().min(1), z.null()]),
    callId: z.string().min(1),
    tool: z.string().min(1),
    arguments: z.unknown(),
  })
  .passthrough();

export const toolCallResultSchema = z
  .object({
    success: z.boolean(),
    contentItems: z.array(
      z.discriminatedUnion("type", [
        z.object({ type: z.literal("inputText"), text: z.string() }),
        z.object({
          type: z.literal("inputImage"),
          imageUrl: z.string().min(1),
        }),
      ]),
    ),
  })
  .passthrough();

export const interactionRequestParamsSchema = z
  .object({
    providerThreadId: z.string().min(1),
    threadId: z.string().min(1).optional(),
    turnId: z.union([z.string().min(1), z.null()]),
    payload: pendingInteractionPayloadSchema,
    providerNativeIds: z.boolean().optional(),
  })
  .passthrough();

export type InteractionRequestParams = z.infer<
  typeof interactionRequestParamsSchema
>;
