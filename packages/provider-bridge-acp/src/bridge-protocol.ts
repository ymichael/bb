import {
  acpNativeReasoningSchema as acpBridgeNativeReasoningSchema,
  acpPermissionCliSchema as acpBridgePermissionCliSchema,
  acpReasoningCliSchema as acpBridgeReasoningCliSchema,
} from "@bb/domain";
import {
  initializeParamsSchema,
  providerInstallationRunParamsSchema,
  providerInstallationStatusParamsSchema,
  providerMaintenanceParamsSchema,
  modelListParamsSchema as canonicalModelListParamsSchema,
  skillsConfigureParamsSchema,
  threadDiscardParamsSchema as canonicalThreadDiscardParamsSchema,
  threadForkParamsSchema as canonicalThreadForkParamsSchema,
  threadResumeParamsSchema as canonicalThreadResumeParamsSchema,
  threadStartParamsSchema as canonicalThreadStartParamsSchema,
  threadStopParamsSchema as canonicalThreadStopParamsSchema,
  turnStartParamsSchema as canonicalTurnStartParamsSchema,
  turnSteerParamsSchema as canonicalTurnSteerParamsSchema,
} from "@bb/provider-bridge-protocol";
import { z } from "zod";
import { acpSessionUpdateSchema, acpStopReasonSchema } from "./wire.js";

export const ACP_DEFAULT_MODEL_ID = "acp-default";

export type AcpBridgeReasoningCli = z.infer<typeof acpBridgeReasoningCliSchema>;

export type AcpBridgeNativeReasoning = z.infer<
  typeof acpBridgeNativeReasoningSchema
>;

export type AcpBridgePermissionCli = z.infer<
  typeof acpBridgePermissionCliSchema
>;

const acpModelListParamsSchema = canonicalModelListParamsSchema.extend({
  providerOptions: z.record(z.string(), z.unknown()).optional(),
});

export const acpBridgeCommandSchema = z.discriminatedUnion("method", [
  z.object({
    method: z.literal("initialize"),
    params: initializeParamsSchema,
  }),
  z.object({
    method: z.literal("model/list"),
    params: acpModelListParamsSchema,
  }),
  z.object({
    method: z.literal("provider/health"),
    params: providerMaintenanceParamsSchema,
  }),
  z.object({
    method: z.literal("provider/usage"),
    params: providerMaintenanceParamsSchema,
  }),
  z.object({
    method: z.literal("provider/installation/status"),
    params: providerInstallationStatusParamsSchema,
  }),
  z.object({
    method: z.literal("provider/installation/run"),
    params: providerInstallationRunParamsSchema,
  }),
  z.object({
    method: z.literal("thread/start"),
    params: canonicalThreadStartParamsSchema,
  }),
  z.object({
    method: z.literal("thread/resume"),
    params: canonicalThreadResumeParamsSchema,
  }),
  z.object({
    method: z.literal("thread/fork"),
    params: canonicalThreadForkParamsSchema,
  }),
  z.object({
    method: z.literal("turn/start"),
    params: canonicalTurnStartParamsSchema,
  }),
  z.object({
    method: z.literal("turn/steer"),
    params: canonicalTurnSteerParamsSchema,
  }),
  z.object({
    method: z.literal("thread/stop"),
    params: canonicalThreadStopParamsSchema,
  }),
  z.object({
    method: z.literal("thread/discard"),
    params: canonicalThreadDiscardParamsSchema,
  }),
  z.object({
    method: z.literal("skills/configure"),
    params: skillsConfigureParamsSchema,
  }),
]);

export const acpBridgeCommandMethodValues = acpBridgeCommandSchema.options.map(
  (option) => option.shape.method.value,
);
export type AcpBridgeCommand = z.infer<typeof acpBridgeCommandSchema>;

export const ACP_TURN_STARTED_METHOD = "acp/turn/started";
export const ACP_TURN_COMPLETED_METHOD = "acp/turn/completed";
export const ACP_COMPACTION_STARTED_METHOD = "acp/compaction/started";
export const ACP_COMPACTION_COMPLETED_METHOD = "acp/compaction/completed";
export const ACP_UPDATE_METHOD = "acp/update";
export const ACP_FS_WRITE_METHOD = "acp/fs/write";
export const ACP_WARNING_METHOD = "acp/warning";

export const ACP_BRIDGE_NO_ACTIVE_TURN_ERROR_CODE = -32001;

export const acpTurnStartedNotificationParamsSchema = z
  .object({
    threadId: z.string().min(1),
  })
  .passthrough();

export const acpTurnCompletedNotificationParamsSchema = z
  .object({
    threadId: z.string().min(1),
    stopReason: acpStopReasonSchema,
  })
  .passthrough();

export const acpCompactionCompletedNotificationParamsSchema =
  z.discriminatedUnion("status", [
    z
      .object({
        threadId: z.string().min(1),
        status: z.literal("completed"),
      })
      .passthrough(),
    z
      .object({
        threadId: z.string().min(1),
        status: z.literal("interrupted"),
      })
      .passthrough(),
    z
      .object({
        threadId: z.string().min(1),
        status: z.literal("skipped"),
        detail: z.string().min(1),
      })
      .passthrough(),
    z
      .object({
        threadId: z.string().min(1),
        status: z.literal("failed"),
        error: z.string().min(1),
      })
      .passthrough(),
  ]);

export const acpUpdateNotificationParamsSchema = z
  .object({
    threadId: z.string().min(1),
    update: acpSessionUpdateSchema,
  })
  .passthrough();

export const acpFsWriteNotificationParamsSchema = z
  .object({
    threadId: z.string().min(1),
    path: z.string().min(1),
    kind: z.enum(["add", "update"]),
    oldText: z.string().optional(),
    content: z.string(),
  })
  .passthrough();

export const acpWarningNotificationParamsSchema = z
  .object({
    threadId: z.string().min(1),
    summary: z.string().min(1),
    details: z.string().optional(),
  })
  .passthrough();
