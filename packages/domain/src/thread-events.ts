import { z } from "zod";
import {
  approvalPendingInteractionResolutionSchema,
  interactionLifecycleSchema,
  pendingInteractionPermissionGrantApprovalSubjectSchema,
  pendingInteractionStatusSchema,
  userQuestionPendingInteractionPayloadSchema,
  userQuestionPendingInteractionResolutionSchema,
} from "./pending-interactions.js";
import {
  promptInputSchema,
  recordedThreadExecutionOptionsSchema,
} from "./shared-types.js";
import { jsonValueSchema } from "./json-value.js";
import { clientTurnRequestIdSchema } from "./protocol-ids.js";
import {
  systemMessageKindSchema,
  systemMessageSubjectSchema,
} from "./system-message.js";

export const systemEventTypeValues = [
  "client/thread/start",
  "client/turn/requested",
  "client/turn/rejected",
  "client/turn/start",
  "system/error",
  "system/manager/user_message",
  "system/thread/interrupted",
  "system/operation",
  "system/interaction/lifecycle",
  "system/permissionGrant/lifecycle",
  "system/userQuestion/lifecycle",
  "system/thread-provisioning",
  // Legacy persisted watchdog diagnostic; retained for read/decode/render
  // only, with no current producer.
  "system/provider-turn-watchdog",
] as const;

const threadTurnInitiatorValues = ["user", "agent", "system"] as const;
export const threadTurnInitiatorSchema = z.enum(threadTurnInitiatorValues);
export type ThreadTurnInitiator = z.infer<typeof threadTurnInitiatorSchema>;

/**
 * Execution values are historical facts once recorded in the event stream.
 * The stored-event boundary therefore accepts the two retired modes without
 * treating either as a current public preset.
 */
const turnRequestOptionsSchema = recordedThreadExecutionOptionsSchema;

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
  initiator: threadTurnInitiatorSchema,
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
  // Retry provenance, written only when a `turn.failed` gate's retry row
  // dispatches. Both fields are present together or not at all: absence means
  // "this is an original dispatch", which is the overwhelmingly common case.
  // (Supersedes the pre-plugin `continuationOfRequestId` key, which the removed
  // core rate-limit recovery wrote and nothing ever read.)
  /** The original request this attempt re-submits, unchanged across attempts. */
  retryOfRequestId: clientTurnRequestIdSchema.optional(),
  /** Which attempt this is: 2 is the first retry of the original request. */
  retryAttempt: z.number().int().min(2).optional(),
  source: z.enum(["spawn", "tell"]),
  initiator: threadTurnInitiatorSchema,
  senderThreadId: z.string().nullable(),
  systemMessageKind: systemMessageKindSchema.optional(),
  systemMessageSubject: systemMessageSubjectSchema.nullable().optional(),
  input: z.array(promptInputSchema),
  inputGroups: z.array(z.array(promptInputSchema).min(1)).min(1).optional(),
  target: turnRequestTargetSchema,
  request: z.object({
    method: z.enum(["thread/start", "turn/start"]),
    params: z.record(z.string(), z.unknown()),
  }),
  execution: turnRequestOptionsSchema,
});
export type TurnRequestEventData = z.infer<typeof turnRequestEventDataSchema>;

/**
 * The retry marker is one fact in two keys, so a stored request that carries
 * one without the other is malformed — it would misstate which turn a retry
 * re-runs, or which attempt it is. Applied where persisted events are parsed,
 * since the discriminated unions the base schema feeds cannot carry a
 * refinement themselves.
 */
export function refineTurnRequestRetryMarker(
  data: Pick<TurnRequestEventData, "retryOfRequestId" | "retryAttempt">,
  ctx: z.RefinementCtx,
): void {
  if (
    (data.retryOfRequestId === undefined) !==
    (data.retryAttempt === undefined)
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        "retryOfRequestId and retryAttempt must be present together or absent together",
    });
  }
}

export const turnRequestRejectedEventDataSchema = z.object({
  requestId: clientTurnRequestIdSchema,
  reason: z.string().min(1),
  message: z.string().min(1),
});

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

const ownershipChangeOperationActionValues = [
  "assign",
  "release",
  "transfer",
] as const;
const ownershipChangeOperationActionSchema = z.enum(
  ownershipChangeOperationActionValues,
);
export type OwnershipChangeOperationAction = z.infer<
  typeof ownershipChangeOperationActionSchema
>;

export const ownershipChangeOperationMetadataSchema = z.object({
  action: ownershipChangeOperationActionSchema,
  nextParentThreadId: z.string().nullable(),
  nextParentThreadTitle: z.string().nullable(),
  previousParentThreadId: z.string().nullable(),
  previousParentThreadTitle: z.string().nullable(),
});
export type OwnershipChangeOperationMetadata = z.infer<
  typeof ownershipChangeOperationMetadataSchema
>;

export const THREAD_CONTEXT_CLEAR_OPERATION = "context_clear";

export const systemOperationEventDataSchema = z.object({
  operation: z.string(),
  status: z.string(),
  message: z.string(),
  operationId: z.string(),
  metadata: z.record(z.string(), jsonValueSchema).optional(),
});

export const systemInteractionLifecycleEventDataSchema = z.object({
  interaction: interactionLifecycleSchema,
});

export const systemPermissionGrantLifecycleEventDataSchema = z.object({
  interactionId: z.string(),
  providerId: z.string(),
  providerRequestId: z.string(),
  status: pendingInteractionStatusSchema,
  resolution: approvalPendingInteractionResolutionSchema
    .nullable()
    .default(null),
  statusReason: z.string().nullable().default(null),
  subject: pendingInteractionPermissionGrantApprovalSubjectSchema,
});

export const systemUserQuestionLifecycleEventDataSchema = z.object({
  interactionId: z.string(),
  providerId: z.string(),
  providerRequestId: z.string(),
  status: pendingInteractionStatusSchema,
  resolution: userQuestionPendingInteractionResolutionSchema
    .nullable()
    .default(null),
  statusReason: z.string().nullable().default(null),
  payload: userQuestionPendingInteractionPayloadSchema,
});

const systemThreadInterruptedReasonValues = [
  "manual-stop",
  "host-daemon-restarted",
  "provider-turn-idle",
] as const;
export const systemThreadInterruptedReasonSchema = z.enum(
  systemThreadInterruptedReasonValues,
);
export type SystemThreadInterruptedReason = z.infer<
  typeof systemThreadInterruptedReasonSchema
>;

export const systemThreadInterruptedEventDataSchema = z.object({
  reason: systemThreadInterruptedReasonSchema,
  cause: z.literal("host-connection-lost").optional(),
});

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

const systemThreadProvisioningStatusValues = [
  "active",
  "completed",
  "failed",
  "cancelled",
] as const;
const systemThreadProvisioningStatusSchema = z.enum(
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

export const systemLegacyUserMessageEventDataSchema = z.object({
  text: z.string(),
  toolCallId: z.string().optional(),
  turnId: z.string().optional(),
});

export const systemProviderTurnWatchdogEventDataSchema = z.object({
  reason: z.literal("provider-turn-idle"),
  thresholdMs: z.number().int().positive(),
  elapsedMs: z.number().int().nonnegative(),
  activeTurnId: z.string().min(1),
  activeTurnStartedAt: z.number().int().nonnegative(),
  lastActivityEventSequence: z.number().int().positive(),
  lastActivityEventType: z.string().min(1),
  lastActivityEventAt: z.number().int().nonnegative(),
  providerId: z.string().min(1),
  providerThreadId: z.string().min(1).nullable(),
  firedAt: z.number().int().nonnegative(),
});
