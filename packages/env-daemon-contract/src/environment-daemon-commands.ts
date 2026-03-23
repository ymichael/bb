import {
  availableModelSchema,
  dynamicToolSchema,
  promptInputSchema,
  threadEventSchema,
  threadGitDiffCommitSummarySchema,
  threadGitDiffModeSchema,
  threadGitDiffResponseSchema,
  threadGitDiffSelectionSchema,
  threadExecutionOptionsSchema,
  threadStatusSchema,
  threadWorkStatusSchema,
  type ThreadGitDiffCommitSummary,
  type ThreadGitDiffMode,
  type ThreadGitDiffResponse,
  type ThreadGitDiffSelection,
} from "@bb/domain";
import { z } from "zod";
import {
  ENVIRONMENT_DAEMON_PROTOCOL_VERSION,
  daemonDeliveryReasonSchema,
  daemonDeliveryRuntimeStateSchema,
} from "./control.js";

const environmentDaemonThreadEventListSchema = z.array(threadEventSchema);

export const environmentDaemonExecutionOptionsSchema =
  threadExecutionOptionsSchema;
export type EnvironmentDaemonExecutionOptions = z.infer<
  typeof environmentDaemonExecutionOptionsSchema
>;

export const environmentDaemonThreadStartOptionsSchema =
  threadExecutionOptionsSchema.extend({
    instructions: z.string().optional(),
  });
export type EnvironmentDaemonThreadStartOptions = z.infer<
  typeof environmentDaemonThreadStartOptionsSchema
>;

export const environmentDaemonThreadGitDiffCommitSummarySchema =
  threadGitDiffCommitSummarySchema;
export type EnvironmentDaemonThreadGitDiffCommitSummary =
  ThreadGitDiffCommitSummary;

export const environmentDaemonThreadGitDiffSelectionSchema =
  threadGitDiffSelectionSchema;
export type EnvironmentDaemonThreadGitDiffSelection =
  ThreadGitDiffSelection;

export const environmentDaemonThreadGitDiffModeSchema = threadGitDiffModeSchema;
export type EnvironmentDaemonThreadGitDiffMode = ThreadGitDiffMode;

export const environmentDaemonThreadGitDiffResponseSchema =
  threadGitDiffResponseSchema;
export type EnvironmentDaemonThreadGitDiffResponse = ThreadGitDiffResponse;

export const ENVIRONMENT_DAEMON_COMMAND_TYPES = [
  "thread.start",
  "thread.resume",
  "turn.run",
  "turn.steer",
  "thread.stop",
  "thread.rename",
  "provider.list_models",
  "workspace.status",
  "workspace.diff",
] as const;

export const environmentDaemonCommandTypeSchema = z.enum(
  ENVIRONMENT_DAEMON_COMMAND_TYPES,
);
export type EnvironmentDaemonCommandType = z.infer<
  typeof environmentDaemonCommandTypeSchema
>;

export const threadStartCommandSchema = z.object({
  type: z.literal("thread.start"),
  threadId: z.string().min(1),
  projectId: z.string().min(1),
  providerId: z.string().min(1).optional(),
  input: z.array(promptInputSchema).min(1).optional(),
  options: environmentDaemonThreadStartOptionsSchema.optional(),
  dynamicTools: z.array(dynamicToolSchema).optional(),
});

export const threadResumeCommandSchema = z.object({
  type: z.literal("thread.resume"),
  threadId: z.string().min(1),
  projectId: z.string().min(1).optional(),
  providerThreadId: z.string().min(1).optional(),
  providerId: z.string().min(1).optional(),
  options: environmentDaemonExecutionOptionsSchema.optional(),
  resumePath: z.string().min(1).optional(),
  dynamicTools: z.array(dynamicToolSchema).optional(),
});

export const turnRunCommandSchema = z.object({
  type: z.literal("turn.run"),
  threadId: z.string().min(1),
  input: z.array(promptInputSchema).min(1),
  options: environmentDaemonExecutionOptionsSchema.optional(),
});

export const turnSteerCommandSchema = z.object({
  type: z.literal("turn.steer"),
  threadId: z.string().min(1),
  expectedTurnId: z.string().min(1),
  input: z.array(promptInputSchema).min(1),
});

export const threadStopCommandSchema = z.object({
  type: z.literal("thread.stop"),
  threadId: z.string().min(1),
});

export const threadRenameCommandSchema = z.object({
  type: z.literal("thread.rename"),
  threadId: z.string().min(1),
  title: z.string().min(1),
});

export const providerListModelsCommandSchema = z.object({
  type: z.literal("provider.list_models"),
  providerId: z.string().min(1),
});

export const workspaceStatusCommandSchema = z.object({
  type: z.literal("workspace.status"),
  threadId: z.string().min(1),
});

export const workspaceDiffCommandSchema = z.object({
  type: z.literal("workspace.diff"),
  threadId: z.string().min(1),
});

export const environmentDaemonCommandSchema = z.discriminatedUnion("type", [
  threadStartCommandSchema,
  threadResumeCommandSchema,
  turnRunCommandSchema,
  turnSteerCommandSchema,
  threadStopCommandSchema,
  threadRenameCommandSchema,
  providerListModelsCommandSchema,
  workspaceStatusCommandSchema,
  workspaceDiffCommandSchema,
]);
export type EnvironmentDaemonCommand = z.infer<
  typeof environmentDaemonCommandSchema
>;

export const environmentDaemonCommandResultSchemaByType = {
  "thread.start": z.object({
    providerThreadId: z.string().min(1),
  }),
  "thread.resume": z.object({
    providerThreadId: z.string().min(1).optional(),
  }),
  "turn.run": z.object({}),
  "turn.steer": z.object({}),
  "thread.stop": z.object({}),
  "thread.rename": z.object({}),
  "provider.list_models": z.object({
    models: z.array(availableModelSchema),
  }),
  "workspace.status": z.object({
    workStatus: threadWorkStatusSchema.nullable(),
  }),
  "workspace.diff": z.object({
    gitDiff: environmentDaemonThreadGitDiffResponseSchema,
  }),
} as const satisfies Record<EnvironmentDaemonCommandType, z.ZodTypeAny>;

export type EnvironmentDaemonCommandResultByType = {
  [K in keyof typeof environmentDaemonCommandResultSchemaByType]: z.infer<
    (typeof environmentDaemonCommandResultSchemaByType)[K]
  >;
};

export type EnvironmentDaemonCommandResult<
  TType extends EnvironmentDaemonCommandType = EnvironmentDaemonCommandType,
> = EnvironmentDaemonCommandResultByType[TType];

export const environmentDaemonCommandMetadataSchema = z.object({
  protocolVersion: z.literal(ENVIRONMENT_DAEMON_PROTOCOL_VERSION),
  commandId: z.string().min(1),
  idempotencyKey: z.string().min(1),
  sentAt: z.number().int().nonnegative(),
  threadId: z.string().min(1).optional(),
  projectId: z.string().min(1).optional(),
  expectedAfterSequence: z.number().int().nonnegative().optional(),
});
export type EnvironmentDaemonCommandMetadata = z.infer<
  typeof environmentDaemonCommandMetadataSchema
>;

export const environmentDaemonCommandEnvelopeSchema = z.object({
  meta: environmentDaemonCommandMetadataSchema,
  command: environmentDaemonCommandSchema,
});
export type EnvironmentDaemonCommandEnvelope = z.infer<
  typeof environmentDaemonCommandEnvelopeSchema
>;

export const environmentDaemonCommandDeliveryStateSchema = z.enum([
  "accepted",
  "duplicate",
  "rejected",
]);
export type EnvironmentDaemonCommandDeliveryState = z.infer<
  typeof environmentDaemonCommandDeliveryStateSchema
>;

export const environmentDaemonCommandAckSchema = z.object({
  protocolVersion: z.literal(ENVIRONMENT_DAEMON_PROTOCOL_VERSION),
  commandId: z.string().min(1),
  idempotencyKey: z.string().min(1),
  state: environmentDaemonCommandDeliveryStateSchema,
  acknowledgedAt: z.number().int().nonnegative(),
  latestSequence: z.number().int().nonnegative(),
  errorCode: z.string().optional(),
  message: z.string().optional(),
});
export type EnvironmentDaemonCommandAck = z.infer<
  typeof environmentDaemonCommandAckSchema
>;

export const environmentDaemonEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("environment.ready"),
    threadId: z.string().min(1),
  }),
  z.object({
    type: z.literal("environment.degraded"),
    threadId: z.string().min(1),
    message: z.string(),
  }),
  z.object({
    type: z.literal("thread.started"),
    threadId: z.string().min(1),
    providerThreadId: z.string().min(1),
  }),
  z.object({
    type: z.literal("thread.stopped"),
    threadId: z.string().min(1),
  }),
  z.object({
    type: z.literal("turn.started"),
    threadId: z.string().min(1),
    turnId: z.string().min(1).optional(),
  }),
  z.object({
    type: z.literal("turn.completed"),
    threadId: z.string().min(1),
    turnId: z.string().min(1).optional(),
  }),
  z.object({
    type: z.literal("thread.event_batch"),
    threadId: z.string().min(1),
    events: environmentDaemonThreadEventListSchema,
  }),
  z.object({
    type: z.literal("workspace.status.changed"),
    threadId: z.string().min(1),
  }),
  z.object({
    type: z.literal("thread.error"),
    threadId: z.string().min(1),
    errorCode: z.string().min(1),
    message: z.string().min(1),
    nextStatus: threadStatusSchema.optional(),
  }),
]);
export type EnvironmentDaemonEvent = z.infer<
  typeof environmentDaemonEventSchema
>;

export const environmentDaemonEventEnvelopeSchema = z.object({
  protocolVersion: z.literal(ENVIRONMENT_DAEMON_PROTOCOL_VERSION),
  sequence: z.number().int().nonnegative(),
  emittedAt: z.number().int().nonnegative(),
  threadId: z.string().min(1),
  event: environmentDaemonEventSchema,
});
export type EnvironmentDaemonEventEnvelope = z.infer<
  typeof environmentDaemonEventEnvelopeSchema
>;

export const environmentDaemonDeliveryReasonSchema =
  daemonDeliveryReasonSchema;
export type EnvironmentDaemonDeliveryReason = z.infer<
  typeof environmentDaemonDeliveryReasonSchema
>;

export const environmentDaemonDeliveryRuntimeStateSchema =
  daemonDeliveryRuntimeStateSchema;
export type EnvironmentDaemonDeliveryRuntimeState = z.infer<
  typeof environmentDaemonDeliveryRuntimeStateSchema
>;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

export function decodePersistedEnvironmentDaemonCommand(args: {
  commandType: string;
  payload: unknown;
}): EnvironmentDaemonCommand {
  const payloadRecord = asRecord(args.payload);
  if (!payloadRecord) {
    throw new Error(
      `Invalid persisted environment-daemon command payload for ${args.commandType}`,
    );
  }
  const parseResult = environmentDaemonCommandSchema.safeParse({
    ...payloadRecord,
    type: args.commandType,
  });
  if (parseResult.success) {
    return parseResult.data;
  }
  const issues = parseResult.error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join(".") : "payload";
    return `${path}: ${issue.message}`;
  });
  throw new Error(
    `Invalid persisted environment-daemon command payload for ${args.commandType}: ${issues.join("; ")}`,
  );
}
