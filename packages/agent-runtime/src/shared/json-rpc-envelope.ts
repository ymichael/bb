import { z } from "zod";

const recordSchema = z.record(z.string(), z.unknown());

export const jsonRpcEnvelopeSchema = z.object({
  jsonrpc: z.literal("2.0"),
  method: z.string(),
  params: recordSchema.optional(),
}).passthrough();

export const sdkMessageEnvelopeSchema = z.object({
  jsonrpc: z.literal("2.0"),
  method: z.literal("sdk/message"),
  params: z.object({
    message: z.unknown(),
    threadId: z.string().optional(),
    parent_tool_use_id: z.string().optional(),
  }).passthrough(),
}).passthrough();

export const threadIdentityEnvelopeSchema = z.object({
  jsonrpc: z.literal("2.0"),
  method: z.literal("thread/identity"),
  params: z.object({
    threadId: z.string().optional(),
    providerThreadId: z.string().optional(),
  }).passthrough(),
}).passthrough();

export const threadContextWindowUsageEnvelopeSchema = z.object({
  jsonrpc: z.literal("2.0"),
  method: z.literal("thread/contextWindowUsage/updated"),
  params: z.object({
    threadId: z.string().optional(),
    contextWindowUsage: z.object({
      usedTokens: z.number().nullable(),
      modelContextWindow: z.number().nullable(),
      estimated: z.boolean(),
    }),
  }).passthrough(),
}).passthrough();

export const errorEnvelopeSchema = z.object({
  jsonrpc: z.literal("2.0"),
  method: z.literal("error"),
  params: z.object({
    message: z.string().optional(),
  }).passthrough().optional(),
}).passthrough();

export type JsonRpcEnvelope = z.infer<typeof jsonRpcEnvelopeSchema>;
export type SdkMessageEnvelope = z.infer<typeof sdkMessageEnvelopeSchema>;
export type ThreadIdentityEnvelope = z.infer<typeof threadIdentityEnvelopeSchema>;
export type ThreadContextWindowUsageEnvelope = z.infer<
  typeof threadContextWindowUsageEnvelopeSchema
>;
export type ErrorEnvelope = z.infer<typeof errorEnvelopeSchema>;
