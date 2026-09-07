import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const idSchema = z.string().min(1).max(160);
export const sessionIdSchema = z.string().uuid();
export const sessionSchema = z
  .object({
    id: sessionIdSchema,
    threadId: idSchema,
    hostId: idSchema,
    backend: z.enum(["desktop", "local"]),
    state: z.enum(["ready", "stopped", "closed"]),
    createdAt: z.number().int(),
    expiresAt: z.number().int(),
  })
  .strict();
export type Session = z.infer<typeof sessionSchema>;
export const selectionSchema = z.discriminatedUnion("backend", [
  z.object({ backend: z.literal("local"), hostId: idSchema }).strict(),
  z
    .object({
      backend: z.literal("desktop"),
      hostId: idSchema,
      instanceId: idSchema,
      tabId: idSchema.optional(),
    })
    .strict(),
]);
export const openSchema = z
  .object({ threadId: idSchema, selection: selectionSchema })
  .strict();
export const ownedSchema = z
  .object({ threadId: idSchema, sessionId: sessionIdSchema })
  .strict();
export const runSchema = ownedSchema.extend({
  script: z.string().min(1).max(128_000),
  timeoutMs: z.number().int().min(1000).max(120_000).default(30_000),
});
export const screenshotSchema = ownedSchema.extend({
  page: z.string().min(1).max(120).default("main"),
});
export const imageSchema = z
  .object({
    path: z.string().min(1),
    mimeType: z.literal("image/jpeg"),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  })
  .strict();
export const outputSchema = z
  .object({
    text: z.string().max(160_000),
    images: z.array(imageSchema).max(4),
    exitCode: z.number().int(),
  })
  .strict();
export type RunOutput = z.infer<typeof outputSchema>;
export const rpcContract = defineRpcContract({
  open: { input: openSchema, output: sessionSchema },
  list: {
    input: z.object({ threadId: idSchema }).strict(),
    output: z.array(sessionSchema).max(64),
  },
  run: { input: runSchema, output: outputSchema },
  pages: { input: ownedSchema, output: outputSchema },
  screenshot: { input: screenshotSchema, output: outputSchema },
  stop: { input: ownedSchema, output: sessionSchema },
  close: { input: ownedSchema, output: sessionSchema },
});
export const runtimeStateSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("ready"),
      version: z.string(),
      source: z.enum(["release", "developer-artifact"]),
    })
    .strict(),
  z.object({ status: z.literal("installing"), detail: z.string() }).strict(),
]);
export type RuntimeState = z.infer<typeof runtimeStateSchema>;
export const hostContract = defineRpcContract({
  prepare: { input: z.object({}).strict(), output: runtimeStateSchema },
  open: {
    input: z
      .object({
        sessionId: sessionIdSchema,
        connectionUrl: z.string().url().optional(),
        expiresAt: z.number().int(),
        idleTimeoutMs: z.number().int().positive(),
      })
      .strict(),
    output: z.null(),
  },
  run: {
    input: z
      .object({
        sessionId: sessionIdSchema,
        script: z.string().min(1).max(128_000),
        timeoutMs: z.number().int().min(1000).max(120_000),
      })
      .strict(),
    output: outputSchema,
  },
  stop: {
    input: z.object({ sessionId: sessionIdSchema }).strict(),
    output: z.null(),
  },
  close: {
    input: z.object({ sessionId: sessionIdSchema }).strict(),
    output: z.null(),
  },
});
