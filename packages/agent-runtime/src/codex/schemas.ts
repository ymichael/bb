import { z } from "zod";
import {
  pendingInteractionCommandActionSchema,
  pendingInteractionFileSystemPermissionsSchema,
  pendingInteractionMacOsPermissionsSchema,
  pendingInteractionNetworkPermissionsSchema,
} from "@bb/domain";
import type { PendingInteractionCommandAction } from "@bb/domain";
import { jsonRpcEnvelopeSchema } from "../shared/json-rpc-envelope.js";

export const codexTurnStatusSchema = z.enum([
  "completed",
  "failed",
  "interrupted",
  "inProgress",
]);
export type CodexTurnStatus = z.infer<typeof codexTurnStatusSchema>;

export const codexItemStatusSchema = z.enum([
  "inProgress",
  "completed",
  "failed",
  "declined",
]);
export type CodexItemStatus = z.infer<typeof codexItemStatusSchema>;

const codexPlanStepStatusSchema = z.enum([
  "pending",
  "inProgress",
  "completed",
  "failed",
]);

type ZodObjectSchema = z.ZodObject<z.ZodRawShape>;

const codexStringArraySchema = z.array(z.string());

export const codexUserInputSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("text"),
    text: z.string(),
    text_elements: z.array(z.unknown()).optional(),
  }).passthrough(),
  z.object({
    type: z.literal("image"),
    url: z.string(),
  }).passthrough(),
  z.object({
    type: z.literal("localImage"),
    path: z.string(),
  }).passthrough(),
  z.object({
    type: z.literal("skill"),
    name: z.string(),
    path: z.string(),
  }).passthrough(),
  z.object({
    type: z.literal("mention"),
    name: z.string(),
    path: z.string(),
  }).passthrough(),
]);
export type CodexParsedUserInput = z.infer<typeof codexUserInputSchema>;

const codexToolReferenceStatusSchema = z.enum([
  "inProgress",
  "completed",
  "failed",
  "declined",
]);

const codexFileChangeKindSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("add") }).passthrough(),
  z.object({ type: z.literal("delete") }).passthrough(),
  z.object({
    type: z.literal("update"),
    move_path: z.string().nullable().optional(),
  }).passthrough(),
]);

const codexFileChangeSchema = z.object({
  path: z.string(),
  kind: codexFileChangeKindSchema,
  diff: z.string(),
}).passthrough();

export const codexDynamicToolCallContentItemSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("inputText"),
    text: z.string(),
  }).passthrough(),
  z.object({
    type: z.literal("inputImage"),
    imageUrl: z.string(),
  }).passthrough(),
]);
export type CodexDynamicToolCallContentItem = z.infer<
  typeof codexDynamicToolCallContentItemSchema
>;

const codexWebSearchActionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("search"),
    query: z.string().optional(),
    queries: z.array(z.string()).nullable().optional(),
  }).passthrough(),
  z.object({
    type: z.literal("open_page"),
    url: z.string().optional(),
  }).passthrough(),
  z.object({
    type: z.literal("find_in_page"),
    url: z.string().optional(),
    pattern: z.string().optional(),
  }).passthrough(),
  z.object({
    type: z.literal("other"),
  }).passthrough(),
]);

export const codexSimpleCommandApprovalDecisionSchema = z.enum([
  "accept",
  "acceptForSession",
  "decline",
  "cancel",
]);
export type CodexSimpleCommandApprovalDecision = z.infer<
  typeof codexSimpleCommandApprovalDecisionSchema
>;

const codexExecPolicyAmendmentDecisionSchema = z.object({
  acceptWithExecpolicyAmendment: z.object({
    execpolicy_amendment: z.array(z.string()),
  }),
});

const codexNetworkPolicyAmendmentDecisionSchema = z.object({
  applyNetworkPolicyAmendment: z.object({
    network_policy_amendment: z.object({
      host: z.string(),
      action: z.enum(["allow", "deny"]),
    }),
  }),
});

export const codexCommandApprovalDecisionSchema = z.union([
  codexSimpleCommandApprovalDecisionSchema,
  codexExecPolicyAmendmentDecisionSchema,
  codexNetworkPolicyAmendmentDecisionSchema,
]);
export type CodexCommandApprovalDecision = z.infer<
  typeof codexCommandApprovalDecisionSchema
>;

const codexFileSystemPermissionsSchema = z.object({
  read: z.array(z.string()).nullable(),
  write: z.array(z.string()).nullable(),
}).transform((value) =>
  pendingInteractionFileSystemPermissionsSchema.parse({
    read: value.read ?? [],
    write: value.write ?? [],
  })
);

const codexNetworkPermissionsSchema = z.object({
  enabled: z.boolean().nullable(),
}).transform((value) => pendingInteractionNetworkPermissionsSchema.parse(value));

const codexMacOsAutomationPermissionSchema = z.union([
  z.literal("none"),
  z.literal("all"),
  z.object({
    bundle_ids: z.array(z.string()),
  }).transform((value) => ({
    kind: "bundle_ids" as const,
    bundleIds: value.bundle_ids,
  })),
]);

const codexAdditionalMacOsPermissionsSchema = z.object({
  preferences: z.string(),
  automations: codexMacOsAutomationPermissionSchema,
  launchServices: z.boolean(),
  accessibility: z.boolean(),
  calendar: z.boolean(),
  reminders: z.boolean(),
  contacts: z.string(),
}).transform((value) => pendingInteractionMacOsPermissionsSchema.parse(value));

export const codexAdditionalPermissionsSchema = z.object({
  network: codexNetworkPermissionsSchema.nullable(),
  fileSystem: codexFileSystemPermissionsSchema.nullable(),
  macos: codexAdditionalMacOsPermissionsSchema.nullable().optional(),
});
export type CodexAdditionalPermissions = z.infer<
  typeof codexAdditionalPermissionsSchema
>;

export const codexRequestPermissionsSchema = z.object({
  network: codexNetworkPermissionsSchema.nullable(),
  fileSystem: codexFileSystemPermissionsSchema.nullable(),
});
export type CodexRequestedPermissionProfile = z.infer<
  typeof codexRequestPermissionsSchema
>;

const codexCommandActionInputSchema = z.object({
  type: z.string(),
}).passthrough();

const codexCommandActionsSchema = z.array(codexCommandActionInputSchema)
  .nullable()
  .optional()
  .transform((value, ctx): PendingInteractionCommandAction[] | null | undefined => {
    if (value == null) {
      return value;
    }

    const parsedActions: PendingInteractionCommandAction[] = [];
    for (const action of value) {
      const parsedAction = pendingInteractionCommandActionSchema.safeParse(action);
      if (!parsedAction.success) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Invalid command action",
        });
        return z.NEVER;
      }
      parsedActions.push(parsedAction.data);
    }

    return parsedActions;
  });

export const codexCommandExecutionRequestApprovalParamsSchema = z.object({
  threadId: z.string(),
  turnId: z.string(),
  itemId: z.string(),
  approvalId: z.string().nullable().optional(),
  reason: z.string().nullable().optional(),
  command: z.string().nullable().optional(),
  cwd: z.string().nullable().optional(),
  commandActions: codexCommandActionsSchema,
  additionalPermissions: codexAdditionalPermissionsSchema.nullable().optional(),
  availableDecisions: z.array(codexCommandApprovalDecisionSchema).nullable().optional(),
});

export const codexFileChangeRequestApprovalParamsSchema = z.object({
  threadId: z.string(),
  turnId: z.string(),
  itemId: z.string(),
  reason: z.string().nullable().optional(),
  grantRoot: z.string().nullable().optional(),
});

export const codexPermissionsRequestApprovalParamsSchema = z.object({
  threadId: z.string(),
  turnId: z.string(),
  itemId: z.string(),
  reason: z.string().nullable(),
  permissions: codexRequestPermissionsSchema,
});

const codexThreadItemEnvelopeSchema = z.object({
  type: z.string(),
  id: z.string(),
}).passthrough();

export const codexHandledThreadItemSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("agentMessage"),
    id: z.string(),
    text: z.string(),
  }).passthrough(),
  z.object({
    type: z.literal("userMessage"),
    id: z.string(),
    content: z.array(codexUserInputSchema),
  }).passthrough(),
  z.object({
    type: z.literal("commandExecution"),
    id: z.string(),
    command: z.string(),
    cwd: z.string(),
    status: codexToolReferenceStatusSchema,
    aggregatedOutput: z.string().nullable(),
    exitCode: z.number().nullable(),
    durationMs: z.number().nullable(),
  }).passthrough(),
  z.object({
    type: z.literal("fileChange"),
    id: z.string(),
    changes: z.array(codexFileChangeSchema),
    status: codexToolReferenceStatusSchema,
  }).passthrough(),
  z.object({
    type: z.literal("mcpToolCall"),
    id: z.string(),
    server: z.string(),
    tool: z.string(),
    status: codexToolReferenceStatusSchema,
    arguments: z.unknown(),
    error: z.object({
      message: z.string().optional(),
    }).passthrough().nullable().optional(),
    durationMs: z.number().nullable(),
  }).passthrough(),
  z.object({
    type: z.literal("dynamicToolCall"),
    id: z.string(),
    tool: z.string(),
    arguments: z.unknown(),
    status: codexToolReferenceStatusSchema,
    contentItems: z.array(codexDynamicToolCallContentItemSchema).nullable(),
    success: z.boolean().nullable(),
    durationMs: z.number().nullable(),
  }).passthrough(),
  z.object({
    type: z.literal("collabAgentToolCall"),
    id: z.string(),
    tool: z.string(),
    status: codexToolReferenceStatusSchema,
    senderThreadId: z.string(),
    receiverThreadIds: z.array(z.string()),
    prompt: z.string().nullable(),
    model: z.string().nullable(),
    reasoningEffort: z.string().nullable(),
    agentsStates: z.record(z.string(), z.unknown()),
  }).passthrough(),
  z.object({
    type: z.literal("webSearch"),
    id: z.string(),
    query: z.string(),
    action: codexWebSearchActionSchema.nullable(),
  }).passthrough(),
  z.object({
    type: z.literal("reasoning"),
    id: z.string(),
    summary: codexStringArraySchema,
    content: codexStringArraySchema,
  }).passthrough(),
  z.object({
    type: z.literal("plan"),
    id: z.string(),
    text: z.string(),
  }).passthrough(),
  z.object({
    type: z.literal("contextCompaction"),
    id: z.string(),
  }).passthrough(),
]);
export type CodexHandledThreadItem = z.infer<typeof codexHandledThreadItemSchema>;

const codexThreadTurnParamsSchema = z.object({
  threadId: z.string(),
  turnId: z.string(),
}).passthrough();

const codexTurnSchema = z.object({
  id: z.string(),
  status: codexTurnStatusSchema,
  error: z.object({
    message: z.string(),
    additionalDetails: z.string().nullish(),
  }).passthrough().nullable().optional(),
}).passthrough();

const codexThreadSchema = z.object({
  id: z.string(),
  preview: z.string().optional(),
}).passthrough();

const codexTokenUsageBreakdownSchema = z.object({
  totalTokens: z.number(),
  inputTokens: z.number(),
  cachedInputTokens: z.number(),
  outputTokens: z.number(),
  reasoningOutputTokens: z.number(),
}).passthrough();

const codexTokenUsageSchema = z.object({
  total: codexTokenUsageBreakdownSchema,
  last: codexTokenUsageBreakdownSchema,
  modelContextWindow: z.number().nullable(),
}).passthrough();

const codexPlanStepSchema = z.object({
  step: z.string(),
  status: codexPlanStepStatusSchema,
}).passthrough();

const codexWarningParamsSchema = z.object({
  summary: z.string(),
  details: z.string().nullish(),
}).passthrough();

export const codexBridgeEnvelopeSchema = z.union([
  jsonRpcEnvelopeSchema,
  z.object({
    method: z.string(),
    params: z.record(z.string(), z.unknown()).optional(),
  }).passthrough(),
]);

function createCodexEventSchema<
  TMethod extends string,
  TParams extends ZodObjectSchema,
>(
  method: TMethod,
  params: TParams,
) {
  return z.object({
    method: z.literal(method),
    params,
  });
}

export const codexHandledEventSchema = z.discriminatedUnion("method", [
  createCodexEventSchema("turn/started", z.object({
    threadId: z.string(),
    turn: codexTurnSchema,
  }).passthrough()),
  createCodexEventSchema("turn/completed", z.object({
    threadId: z.string(),
    turn: codexTurnSchema,
  }).passthrough()),
  createCodexEventSchema("thread/started", z.object({
    thread: codexThreadSchema,
  }).passthrough()),
  createCodexEventSchema("thread/name/updated", z.object({
    threadId: z.string(),
    threadName: z.string().optional(),
  }).passthrough()),
  createCodexEventSchema("thread/compacted", z.object({
    threadId: z.string(),
  }).passthrough()),
  createCodexEventSchema("item/started", z.object({
    threadId: z.string(),
    turnId: z.string(),
    item: codexThreadItemEnvelopeSchema,
  }).passthrough()),
  createCodexEventSchema("item/completed", z.object({
    threadId: z.string(),
    turnId: z.string(),
    item: codexThreadItemEnvelopeSchema,
  }).passthrough()),
  createCodexEventSchema("item/agentMessage/delta", codexThreadTurnParamsSchema.extend({
    itemId: z.string(),
    delta: z.string(),
  })),
  createCodexEventSchema("item/commandExecution/outputDelta", codexThreadTurnParamsSchema.extend({
    itemId: z.string(),
    delta: z.string(),
  })),
  createCodexEventSchema("item/fileChange/outputDelta", codexThreadTurnParamsSchema.extend({
    itemId: z.string(),
    delta: z.string(),
  })),
  createCodexEventSchema("item/reasoning/summaryTextDelta", codexThreadTurnParamsSchema.extend({
    itemId: z.string(),
    delta: z.string(),
  })),
  createCodexEventSchema("item/reasoning/textDelta", codexThreadTurnParamsSchema.extend({
    itemId: z.string(),
    delta: z.string(),
  })),
  createCodexEventSchema("item/plan/delta", codexThreadTurnParamsSchema.extend({
    itemId: z.string(),
    delta: z.string(),
  })),
  createCodexEventSchema("item/mcpToolCall/progress", codexThreadTurnParamsSchema.extend({
    itemId: z.string(),
    message: z.string().optional(),
  })),
  createCodexEventSchema("thread/tokenUsage/updated", codexThreadTurnParamsSchema.extend({
    tokenUsage: codexTokenUsageSchema,
  })),
  createCodexEventSchema("turn/plan/updated", codexThreadTurnParamsSchema.extend({
    plan: z.array(codexPlanStepSchema),
    explanation: z.string().nullish(),
  })),
  createCodexEventSchema("turn/diff/updated", codexThreadTurnParamsSchema.extend({
    diff: z.string(),
  })),
  createCodexEventSchema("error", z.object({
    threadId: z.string(),
    turnId: z.string().optional(),
    error: z.object({
      message: z.string(),
      additionalDetails: z.string().nullish(),
    }).passthrough(),
    willRetry: z.boolean().optional(),
  }).passthrough()),
  createCodexEventSchema("deprecationNotice", codexWarningParamsSchema),
  createCodexEventSchema("configWarning", codexWarningParamsSchema),
]);
export type CodexHandledEvent = z.infer<typeof codexHandledEventSchema>;
type HandledCodexMethod = CodexHandledEvent["method"];

const handledCodexMethodSet = new Set<string>(
  codexHandledEventSchema.options.map((option) => option.shape.method.value),
);

export function isHandledCodexMethod(method: string): method is HandledCodexMethod {
  return handledCodexMethodSet.has(method);
}
