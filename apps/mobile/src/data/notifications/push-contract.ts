import { z } from "zod";

export const pushPlatformSchema = z.enum(["ios", "android"]);

const EXPO_PUSH_TOKEN_MAX_LENGTH = 512;
const DEVICE_LABEL_MAX_LENGTH = 120;

export const pushSubscriptionInputSchema = z
  .object({
    expoPushToken: z.string().trim().min(1).max(EXPO_PUSH_TOKEN_MAX_LENGTH),
    platform: pushPlatformSchema,
    deviceLabel: z.string().trim().min(1).max(DEVICE_LABEL_MAX_LENGTH),
  })
  .strict();

export const pushSubscriptionRecordSchema = z
  .object({
    id: z.string().min(1),
    platform: pushPlatformSchema,
    deviceLabel: z.string().min(1).max(DEVICE_LABEL_MAX_LENGTH),
    createdAt: z.number().int().nonnegative(),
    lastSeenAt: z.number().int().nonnegative(),
    tokenSuffix: z.string().min(1).max(6),
  })
  .strict();

export const pushSubscriptionsListOutputSchema = z
  .object({
    subscriptions: z.array(pushSubscriptionRecordSchema),
  })
  .strict();

export const pushSubscriptionsAddOutputSchema = z
  .object({
    id: z.string().min(1),
    created: z.boolean(),
  })
  .strict();

export const pushSubscriptionsRemoveOutputSchema = z
  .object({ ok: z.literal(true) })
  .strict();

export type PushPlatform = z.infer<typeof pushPlatformSchema>;
export type PushSubscriptionInput = z.infer<
  typeof pushSubscriptionInputSchema
>;
export type PushSubscriptionRecord = z.infer<
  typeof pushSubscriptionRecordSchema
>;

export interface PushSubscriptionRef {
  subscriptionId: string | null;
  expoPushToken: string;
  tokenSuffix: string;
}
