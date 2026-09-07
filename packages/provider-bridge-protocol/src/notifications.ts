import { z } from "zod";
import { providerRecoveryHintSchema } from "./errors.js";

export const BRIDGE_NOTIFICATION_METHODS = {
  threadIdentity: "thread/identity",
  sessionReplaced: "session/replaced",
  providerRaw: "provider/raw",
  providerRecovery: "provider/recovery",
  error: "error",
} as const;

export const threadIdentityNotificationSchema = z
  .object({
    threadId: z.string().min(1),
    providerThreadId: z.string().min(1),
    sessionRestorable: z.boolean().optional(),
  })
  .passthrough();

export const sessionReplacedNotificationSchema = z
  .object({
    threadId: z.string().min(1),
    providerThreadId: z.string().min(1).nullable(),
    reason: z.string().min(1),
    contextLost: z.boolean().default(false),
    showRuntimeNote: z.boolean().default(false),
  })
  .passthrough();

export const providerRawNotificationSchema = z
  .object({
    threadId: z.string().min(1).optional(),
    coverage: z.enum(["noise", "unknown"]),
    payload: z.unknown(),
  })
  .passthrough();

export const providerRecoveryNotificationSchema = z
  .object({
    threadId: z.string().min(1).optional(),
    ...providerRecoveryHintSchema.shape,
  })
  .passthrough();

export type ProviderRecoveryNotification = z.infer<
  typeof providerRecoveryNotificationSchema
>;

export const errorNotificationSchema = z
  .object({
    threadId: z.string().min(1).optional(),
    message: z.string().min(1),
  })
  .passthrough();
