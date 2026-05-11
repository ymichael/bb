import { z } from "zod";
import { jsonValueSchema, type JsonObject } from "@bb/domain";

export const timelineRowStatusValues = [
  "pending",
  "completed",
  "error",
  "interrupted",
] as const;
export const timelineRowStatusSchema = z.enum(timelineRowStatusValues);
export type TimelineRowStatus = z.infer<typeof timelineRowStatusSchema>;

export const timelineApprovalStatusValues = [
  "waiting_for_approval",
  "denied",
] as const;
export const timelineApprovalStatusSchema = z
  .enum(timelineApprovalStatusValues)
  .nullable();
export type TimelineApprovalStatus = z.infer<
  typeof timelineApprovalStatusSchema
>;

export const timelineActivityIntentSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("read"),
    command: z.string(),
    name: z.string(),
    path: z.string().nullable(),
  }),
  z.object({
    type: z.literal("list_files"),
    command: z.string(),
    path: z.string().nullable(),
  }),
  z.object({
    type: z.literal("search"),
    command: z.string(),
    query: z.string().nullable(),
    path: z.string().nullable(),
  }),
  z.object({
    type: z.literal("unknown"),
    command: z.string(),
  }),
]);
export type TimelineActivityIntent = z.infer<
  typeof timelineActivityIntentSchema
>;

export const timelineRowBaseSchema = z.object({
  id: z.string(),
  threadId: z.string(),
  turnId: z.string().nullable(),
  sourceSeqStart: z.number().int(),
  sourceSeqEnd: z.number().int(),
  startedAt: z.number(),
  createdAt: z.number(),
});
export type TimelineRowBase = z.infer<typeof timelineRowBaseSchema>;

export const timelineConversationAttachmentsSchema = z.object({
  webImages: z.number().int().nonnegative(),
  localImages: z.number().int().nonnegative(),
  localFiles: z.number().int().nonnegative(),
  imageUrls: z.array(z.string()),
  localImagePaths: z.array(z.string()),
  localFilePaths: z.array(z.string()),
});
export type TimelineConversationAttachments = z.infer<
  typeof timelineConversationAttachmentsSchema
>;

export const timelineConversationUserRequestKindValues = [
  "message",
  "steer",
] as const;
export const timelineConversationUserRequestStatusValues = [
  "pending",
  "accepted",
] as const;
export const timelineConversationUserRequestSchema = z.object({
  kind: z.enum(timelineConversationUserRequestKindValues),
  status: z.enum(timelineConversationUserRequestStatusValues),
});
export type TimelineConversationUserRequest = z.infer<
  typeof timelineConversationUserRequestSchema
>;

const timelineConversationRowBaseSchema = timelineRowBaseSchema.extend({
  kind: z.literal("conversation"),
  text: z.string(),
  attachments: timelineConversationAttachmentsSchema.nullable(),
});

export const timelineUserConversationRowSchema =
  timelineConversationRowBaseSchema.extend({
    role: z.literal("user"),
    userRequest: timelineConversationUserRequestSchema,
  });
export type TimelineUserConversationRow = z.infer<
  typeof timelineUserConversationRowSchema
>;

export const timelineAssistantConversationRowSchema =
  timelineConversationRowBaseSchema.extend({
    role: z.literal("assistant"),
    userRequest: z.null(),
  });
export type TimelineAssistantConversationRow = z.infer<
  typeof timelineAssistantConversationRowSchema
>;

export const timelineConversationRowSchema = z.discriminatedUnion("role", [
  timelineUserConversationRowSchema,
  timelineAssistantConversationRowSchema,
]);
export type TimelineConversationRow = z.infer<
  typeof timelineConversationRowSchema
>;

export const timelineSystemOperationKindValues = [
  "generic",
  "compaction",
  "manager-assignment",
  "thread-provisioning",
  "thread-interrupted",
  "provider-unhandled",
  "warning",
  "deprecation",
] as const;
export const timelineSystemOperationKindSchema = z.enum(
  timelineSystemOperationKindValues,
);
export type TimelineSystemOperationKind = z.infer<
  typeof timelineSystemOperationKindSchema
>;
const timelineGenericSystemOperationKindSchema = z.enum([
  "generic",
  "compaction",
  "thread-provisioning",
  "thread-interrupted",
  "provider-unhandled",
  "warning",
  "deprecation",
] as const);

export const timelineManagerAssignmentActionValues = [
  "assign",
  "release",
  "transfer",
] as const;
export const timelineManagerAssignmentActionSchema = z.enum(
  timelineManagerAssignmentActionValues,
);
export type TimelineManagerAssignmentAction = z.infer<
  typeof timelineManagerAssignmentActionSchema
>;

export const timelineManagerAssignmentSchema = z.object({
  action: timelineManagerAssignmentActionSchema,
  previousManagerThreadId: z.string().nullable(),
  previousManagerThreadTitle: z.string().nullable(),
  nextManagerThreadId: z.string().nullable(),
  nextManagerThreadTitle: z.string().nullable(),
});
export type TimelineManagerAssignment = z.infer<
  typeof timelineManagerAssignmentSchema
>;

const timelineSystemRowBaseSchema = timelineRowBaseSchema.extend({
  kind: z.literal("system"),
  title: z.string(),
  detail: z.string().nullable(),
  status: timelineRowStatusSchema.nullable(),
});

export const timelineNonOperationSystemRowSchema =
  timelineSystemRowBaseSchema.extend({
    systemKind: z.enum(["debug", "error", "reconnect"]),
  });
export type TimelineNonOperationSystemRow = z.infer<
  typeof timelineNonOperationSystemRowSchema
>;

export const timelineGenericOperationSystemRowSchema =
  timelineSystemRowBaseSchema.extend({
    systemKind: z.literal("operation"),
    operationKind: timelineGenericSystemOperationKindSchema,
    completedAt: z.number().nullable(),
  });
export type TimelineGenericOperationSystemRow = z.infer<
  typeof timelineGenericOperationSystemRowSchema
>;

export const timelineManagerAssignmentSystemRowSchema =
  timelineSystemRowBaseSchema.extend({
    systemKind: z.literal("operation"),
    operationKind: z.literal("manager-assignment"),
    status: timelineRowStatusSchema,
    managerAssignment: timelineManagerAssignmentSchema,
    completedAt: z.number().nullable(),
  });
export type TimelineManagerAssignmentSystemRow = z.infer<
  typeof timelineManagerAssignmentSystemRowSchema
>;

export const timelineOperationSystemRowSchema = z.discriminatedUnion(
  "operationKind",
  [
    timelineGenericOperationSystemRowSchema,
    timelineManagerAssignmentSystemRowSchema,
  ],
);
export type TimelineOperationSystemRow = z.infer<
  typeof timelineOperationSystemRowSchema
>;

export const timelineSystemRowSchema = z.union([
  timelineNonOperationSystemRowSchema,
  timelineOperationSystemRowSchema,
]);
export type TimelineSystemRow = z.infer<typeof timelineSystemRowSchema>;

export const timelineDiffStatsSchema = z.object({
  added: z.number().int().nonnegative(),
  removed: z.number().int().nonnegative(),
});
export type TimelineDiffStats = z.infer<typeof timelineDiffStatsSchema>;

export const timelineFileChangeSchema = z.object({
  path: z.string(),
  kind: z.string().nullable(),
  movePath: z.string().nullable(),
  diff: z.string().nullable(),
  diffStats: timelineDiffStatsSchema,
});
export type TimelineFileChange = z.infer<typeof timelineFileChangeSchema>;

const timelineWorkRowBaseSchema = timelineRowBaseSchema.extend({
  kind: z.literal("work"),
  status: timelineRowStatusSchema,
});

interface TimelineWorkRowBase extends TimelineRowBase {
  kind: "work";
  status: TimelineRowStatus;
}

export const timelineCommandWorkRowSchema = timelineWorkRowBaseSchema.extend({
  workKind: z.literal("command"),
  callId: z.string(),
  command: z.string(),
  cwd: z.string().nullable(),
  source: z.string().nullable(),
  output: z.string(),
  exitCode: z.number().nullable(),
  completedAt: z.number().nullable(),
  approvalStatus: timelineApprovalStatusSchema,
  activityIntents: z.array(timelineActivityIntentSchema),
});
export type TimelineCommandWorkRow = z.infer<
  typeof timelineCommandWorkRowSchema
>;

export const timelineToolWorkRowSchema = timelineWorkRowBaseSchema.extend({
  workKind: z.literal("tool"),
  callId: z.string(),
  toolName: z.string(),
  toolArgs: z.record(z.string(), jsonValueSchema).nullable(),
  output: z.string(),
  completedAt: z.number().nullable(),
  approvalStatus: timelineApprovalStatusSchema,
  activityIntents: z.array(timelineActivityIntentSchema),
});
export type TimelineToolWorkRow = z.infer<typeof timelineToolWorkRowSchema>;

export const timelineFileChangeWorkRowSchema = timelineWorkRowBaseSchema.extend(
  {
    workKind: z.literal("file-change"),
    callId: z.string(),
    change: timelineFileChangeSchema,
    stdout: z.string().nullable(),
    stderr: z.string().nullable(),
    approvalStatus: timelineApprovalStatusSchema,
  },
);
export type TimelineFileChangeWorkRow = z.infer<
  typeof timelineFileChangeWorkRowSchema
>;

export const timelineWebSearchWorkRowSchema = timelineWorkRowBaseSchema.extend({
  workKind: z.literal("web-search"),
  callId: z.string(),
  queries: z.array(z.string()),
  completedAt: z.number().nullable(),
});
export type TimelineWebSearchWorkRow = z.infer<
  typeof timelineWebSearchWorkRowSchema
>;

export const timelineWebFetchWorkRowSchema = timelineWorkRowBaseSchema.extend({
  workKind: z.literal("web-fetch"),
  callId: z.string(),
  url: z.string(),
  prompt: z.string().nullable(),
  pattern: z.string().nullable(),
  completedAt: z.number().nullable(),
});
export type TimelineWebFetchWorkRow = z.infer<
  typeof timelineWebFetchWorkRowSchema
>;

export const timelineFileEditApprovalLifecycleValues = [
  "waiting",
  "denied",
] as const;
export const timelinePermissionGrantApprovalLifecycleValues = [
  "pending",
  "resolving",
  "granted",
  "denied",
  "interrupted",
  "expired",
] as const;
export const timelinePermissionGrantApprovalGrantScopeValues = [
  "turn",
  "session",
] as const;
export const timelinePermissionGrantApprovalGrantScopeSchema = z.enum(
  timelinePermissionGrantApprovalGrantScopeValues,
);
export type TimelinePermissionGrantApprovalGrantScope = z.infer<
  typeof timelinePermissionGrantApprovalGrantScopeSchema
>;

const timelineApprovalTargetSchema = z.object({
  itemId: z.string(),
  toolName: z.string().nullable(),
});

const timelineApprovalWorkRowBaseSchema = timelineWorkRowBaseSchema.extend({
  workKind: z.literal("approval"),
  interactionId: z.string(),
  target: timelineApprovalTargetSchema,
});

export const timelineFileEditApprovalWorkRowSchema =
  timelineApprovalWorkRowBaseSchema.extend({
    approvalKind: z.literal("file-edit"),
    lifecycle: z.enum(timelineFileEditApprovalLifecycleValues),
  });

export const timelinePermissionGrantApprovalWorkRowSchema =
  timelineApprovalWorkRowBaseSchema.extend({
    approvalKind: z.literal("permission-grant"),
    lifecycle: z.enum(timelinePermissionGrantApprovalLifecycleValues),
    grantScope: timelinePermissionGrantApprovalGrantScopeSchema.nullable(),
    statusReason: z.string().nullable(),
  });

export const timelineApprovalWorkRowSchema = z.discriminatedUnion(
  "approvalKind",
  [
    timelineFileEditApprovalWorkRowSchema,
    timelinePermissionGrantApprovalWorkRowSchema,
  ],
);
export type TimelineApprovalWorkRow = z.infer<
  typeof timelineApprovalWorkRowSchema
>;

export interface TimelineDelegationWorkRow extends TimelineWorkRowBase {
  workKind: "delegation";
  callId: string;
  toolName: string;
  subagentType: string | null;
  description: string | null;
  output: string;
  completedAt: number | null;
  childRows: TimelineRow[];
}

export const timelineDelegationWorkRowSchema: z.ZodType<TimelineDelegationWorkRow> =
  timelineWorkRowBaseSchema.extend({
    workKind: z.literal("delegation"),
    callId: z.string(),
    toolName: z.string(),
    subagentType: z.string().nullable(),
    description: z.string().nullable(),
    output: z.string(),
    completedAt: z.number().nullable(),
    childRows: z.array(z.lazy(() => timelineRowSchema)),
  });

export type TimelineWorkRow =
  | TimelineCommandWorkRow
  | TimelineToolWorkRow
  | TimelineFileChangeWorkRow
  | TimelineWebSearchWorkRow
  | TimelineWebFetchWorkRow
  | TimelineApprovalWorkRow
  | TimelineDelegationWorkRow;

export const timelineWorkRowSchema: z.ZodType<TimelineWorkRow> = z.union([
  timelineCommandWorkRowSchema,
  timelineToolWorkRowSchema,
  timelineFileChangeWorkRowSchema,
  timelineWebSearchWorkRowSchema,
  timelineWebFetchWorkRowSchema,
  timelineApprovalWorkRowSchema,
  timelineDelegationWorkRowSchema,
]);

export interface TimelineTurnRow extends TimelineRowBase {
  kind: "turn";
  turnId: string;
  status: TimelineRowStatus;
  summaryCount: number;
  completedAt: number | null;
  children: TimelineRow[] | null;
}

export const timelineTurnRowSchema: z.ZodType<TimelineTurnRow> = z.lazy(() =>
  timelineRowBaseSchema.extend({
    kind: z.literal("turn"),
    turnId: z.string().min(1),
    status: timelineRowStatusSchema,
    summaryCount: z.number().int().nonnegative(),
    completedAt: z.number().nullable(),
    children: z.array(timelineRowSchema).nullable(),
  }),
);

export type TimelineSourceRow =
  | TimelineConversationRow
  | TimelineWorkRow
  | TimelineSystemRow;

export type TimelineRow = TimelineSourceRow | TimelineTurnRow;

export const timelineSourceRowSchema = z.union([
  timelineConversationRowSchema,
  timelineWorkRowSchema,
  timelineSystemRowSchema,
]);

export const timelineRowSchema: z.ZodType<TimelineRow> = z.lazy(() =>
  z.union([
    timelineConversationRowSchema,
    timelineWorkRowSchema,
    timelineSystemRowSchema,
    timelineTurnRowSchema,
  ]),
);

export type TimelineToolArgs = JsonObject | null;
