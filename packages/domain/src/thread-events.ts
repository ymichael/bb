import { z } from "zod";
import {
  pendingInteractionPermissionGrantApprovalSubjectSchema,
  pendingInteractionResolutionSchema,
  pendingInteractionStatusSchema,
} from "./pending-interactions.js";
import {
  promptInputSchema,
  resolvedThreadExecutionOptionsSchema,
} from "./shared-types.js";
import { jsonValueSchema } from "./json-value.js";
import { clientTurnRequestIdSchema } from "./protocol-ids.js";

export const systemEventTypeValues = [
  "client/thread/start",
  "client/turn/requested",
  "client/turn/start",
  "system/error",
  "system/manager/user_message",
  "system/thread/interrupted",
  "system/operation",
  "system/permissionGrant/lifecycle",
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

export const turnRequestTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("thread-start") }),
  z.object({ kind: z.literal("new-turn") }),
  z.object({
    kind: z.literal("auto"),
    expectedTurnId: z.string().nullable(),
  }),
  z.object({
    kind: z.literal("steer"),
    expectedTurnId: z.string().nullable(),
  }),
]);
export type TurnRequestTarget = z.infer<typeof turnRequestTargetSchema>;

export const clientTurnLifecycleEventDataSchema = z.object({
  direction: z.literal("outbound"),
  source: z.enum(["spawn", "tell"]),
  initiator: threadTurnInitiatorSchema.optional(),
  request: z.object({
    method: z.enum(["thread/start", "turn/start"]),
    params: z.record(z.string(), z.unknown()),
  }),
});
export type ClientTurnLifecycleEventData = z.infer<
  typeof clientTurnLifecycleEventDataSchema
>;

export const turnRequestEventDataSchema = z.object({
  direction: z.literal("outbound"),
  requestId: clientTurnRequestIdSchema,
  source: z.enum(["spawn", "tell"]),
  initiator: threadTurnInitiatorSchema.optional(),
  input: z.array(promptInputSchema),
  target: turnRequestTargetSchema,
  request: z.object({
    method: z.enum(["thread/start", "turn/start"]),
    params: z.record(z.string(), z.unknown()),
  }),
  execution: turnRequestOptionsSchema,
});
export type TurnRequestEventData = z.infer<typeof turnRequestEventDataSchema>;

export const systemErrorEventDataSchema = z
  .object({
    code: z.string().optional(),
    message: z.string(),
    detail: z.string().optional(),
    reconnectAttempt: z.number().int().positive().optional(),
    reconnectTotal: z.number().int().positive().optional(),
  })
  .superRefine((value, ctx) => {
    const hasReconnectAttempt = value.reconnectAttempt !== undefined;
    const hasReconnectTotal = value.reconnectTotal !== undefined;
    if (hasReconnectAttempt !== hasReconnectTotal) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "system/error reconnectAttempt and reconnectTotal must be provided together",
      });
      return;
    }

    if (
      value.reconnectAttempt !== undefined &&
      value.reconnectTotal !== undefined &&
      value.reconnectAttempt > value.reconnectTotal
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "system/error reconnectAttempt cannot be greater than reconnectTotal",
      });
    }
  });
export type SystemErrorEventData = z.infer<typeof systemErrorEventDataSchema>;

export const ownershipChangeOperationActionValues = [
  "assign",
  "release",
  "transfer",
] as const;
export const ownershipChangeOperationActionSchema = z.enum(
  ownershipChangeOperationActionValues,
);
export type OwnershipChangeOperationAction = z.infer<
  typeof ownershipChangeOperationActionSchema
>;

export const ownershipChangeOperationMetadataSchema = z.object({
  action: ownershipChangeOperationActionSchema,
  nextParentThreadId: z.string().nullable(),
  previousParentThreadId: z.string().nullable(),
});
export type OwnershipChangeOperationMetadata = z.infer<
  typeof ownershipChangeOperationMetadataSchema
>;

export const systemOperationEventDataSchema = z.object({
  operation: z.string(),
  status: z.string(),
  message: z.string(),
  operationId: z.string(),
  metadata: z.record(z.string(), jsonValueSchema).optional(),
});
export type SystemOperationEventData = z.infer<
  typeof systemOperationEventDataSchema
>;

export const systemPermissionGrantLifecycleEventDataSchema = z.object({
  interactionId: z.string(),
  providerId: z.string(),
  providerRequestId: z.string(),
  status: pendingInteractionStatusSchema,
  resolution: pendingInteractionResolutionSchema.nullable().default(null),
  statusReason: z.string().nullable().default(null),
  subject: pendingInteractionPermissionGrantApprovalSubjectSchema,
});
export type SystemPermissionGrantLifecycleEventData = z.infer<
  typeof systemPermissionGrantLifecycleEventDataSchema
>;

export const systemThreadInterruptedReasonValues = [
  "manual-stop",
  "host-daemon-restarted",
] as const;
export const systemThreadInterruptedReasonSchema = z.enum(
  systemThreadInterruptedReasonValues,
);
export type SystemThreadInterruptedReason = z.infer<
  typeof systemThreadInterruptedReasonSchema
>;

export const systemThreadInterruptedEventDataSchema = z.object({
  reason: systemThreadInterruptedReasonSchema,
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
  provisioningId: z.string(),
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
  "client/thread/start": ClientTurnLifecycleEventData;
  "client/turn/requested": TurnRequestEventData;
  "client/turn/start": ClientTurnLifecycleEventData;
  "system/error": SystemErrorEventData;
  "system/manager/user_message": SystemManagerUserMessageEventData;
  "system/thread/interrupted": SystemThreadInterruptedEventData;
  "system/operation": SystemOperationEventData;
  "system/permissionGrant/lifecycle": SystemPermissionGrantLifecycleEventData;
  "system/thread-provisioning": SystemThreadProvisioningEventData;
};

export type ThreadEventData =
  | ThreadEventDataByType[SystemEventType]
  | Record<string, unknown>;

export type ThreadEventDataForType<TType extends string> =
  TType extends SystemEventType
    ? ThreadEventDataByType[TType]
    : Record<string, unknown>;
