import { z } from "zod";
import {
  promptInputSchema,
  resolvedThreadExecutionOptionsSchema,
} from "./shared-types.js";

export const systemEventTypeValues = [
  "client/thread/start",
  "client/turn/requested",
  "client/turn/start",
  "system/error",
  "system/manager/user_message",
  "system/thread/interrupted",
  "system/operation",
  "system/thread-provisioning",
] as const;
export const systemEventTypeSchema = z.enum(systemEventTypeValues);
export type SystemEventType = z.infer<typeof systemEventTypeSchema>;

export const threadTurnInitiatorValues = ["user", "agent", "system"] as const;
export const threadTurnInitiatorSchema = z.enum(threadTurnInitiatorValues);
export type ThreadTurnInitiator = z.infer<typeof threadTurnInitiatorSchema>;

export const threadProvisioningReasonValues = [
  "thread-created",
  "boot-created-thread",
  "tell-after-provisioning-failure",
  "tell-after-missing-environment-attachment",
  "resume-missing-provider-thread",
] as const;
export const threadProvisioningReasonSchema = z.enum(
  threadProvisioningReasonValues,
);
export type ThreadProvisioningReason = z.infer<
  typeof threadProvisioningReasonSchema
>;

export const threadEnvironmentStartReasonValues = [
  ...threadProvisioningReasonValues,
  "boot-active-resume",
  "resume-existing-provider-session",
] as const;
export const threadEnvironmentStartReasonSchema = z.enum(
  threadEnvironmentStartReasonValues,
);
export type ThreadEnvironmentStartReason = z.infer<
  typeof threadEnvironmentStartReasonSchema
>;

export const turnRequestOptionsSchema = resolvedThreadExecutionOptionsSchema;
export type TurnRequestOptions = z.infer<typeof turnRequestOptionsSchema>;

export const turnRequestEventDataSchema = z.object({
  direction: z.literal("outbound"),
  source: z.enum(["spawn", "tell"]),
  initiator: threadTurnInitiatorSchema.optional(),
  input: z.array(promptInputSchema).optional(),
  request: z.object({
    method: z.enum(["thread/start", "turn/start"]),
    params: z.record(z.string(), z.unknown()),
  }),
  execution: turnRequestOptionsSchema,
});
export type TurnRequestEventData = z.infer<typeof turnRequestEventDataSchema>;

export const systemErrorEventDataSchema = z.object({
  code: z.string().optional(),
  message: z.string(),
  detail: z.string().optional(),
});
export type SystemErrorEventData = z.infer<typeof systemErrorEventDataSchema>;

export const systemOperationEventDataSchema = z.object({
  operation: z.string(),
  status: z.string(),
  message: z.string(),
  operationId: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type SystemOperationEventData = z.infer<
  typeof systemOperationEventDataSchema
>;

export const systemThreadInterruptedEventDataSchema = z.object({
  reason: z.literal("user"),
  message: z.string().optional(),
});
export type SystemThreadInterruptedEventData = z.infer<
  typeof systemThreadInterruptedEventDataSchema
>;

export const provisioningTranscriptEntrySchema = z.object({
  type: z.enum(["step", "output"]),
  key: z.string(),
  text: z.string(),
  startedAt: z.number().optional(),
  status: z.enum(["started", "completed", "failed"]).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type ProvisioningTranscriptEntry = z.infer<
  typeof provisioningTranscriptEntrySchema
>;

export const systemThreadProvisioningStatusValues = [
  "active",
  "completed",
  "failed",
] as const;
export const systemThreadProvisioningStatusSchema = z.enum(
  systemThreadProvisioningStatusValues,
);
export type SystemThreadProvisioningStatus = z.infer<
  typeof systemThreadProvisioningStatusSchema
>;

export const systemThreadProvisioningEventDataSchema = z.object({
  status: systemThreadProvisioningStatusSchema,
  environmentId: z.string(),
  entries: z.array(provisioningTranscriptEntrySchema),
});
export type SystemThreadProvisioningEventData = z.infer<
  typeof systemThreadProvisioningEventDataSchema
>;

export const systemManagerUserMessageEventDataSchema = z.object({
  text: z.string(),
  toolCallId: z.string().optional(),
  turnId: z.string().optional(),
});
export type SystemManagerUserMessageEventData = z.infer<
  typeof systemManagerUserMessageEventDataSchema
>;

export const turnLifecycleEventDataSchema = z.object({
  turnId: z.string().optional(),
  input: z.array(promptInputSchema).optional(),
});
export type TurnLifecycleEventData = z.infer<
  typeof turnLifecycleEventDataSchema
>;

export type ThreadEventDataByType = {
  "client/thread/start": TurnRequestEventData;
  "client/turn/requested": TurnRequestEventData;
  "client/turn/start": TurnRequestEventData;
  "system/error": SystemErrorEventData;
  "system/manager/user_message": SystemManagerUserMessageEventData;
  "system/thread/interrupted": SystemThreadInterruptedEventData;
  "system/operation": SystemOperationEventData;
  "system/thread-provisioning": SystemThreadProvisioningEventData;
};

export type ThreadEventData =
  | ThreadEventDataByType[SystemEventType]
  | Record<string, unknown>;

export type ThreadEventDataForType<TType extends string> =
  TType extends SystemEventType
    ? ThreadEventDataByType[TType]
    : Record<string, unknown>;
