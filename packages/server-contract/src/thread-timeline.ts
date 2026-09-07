import { z } from "zod";
import {
  backgroundTaskStatusSchema,
  backgroundTaskUsageSchema,
  extensionKindSchema,
  jsonValueSchema,
  pendingInteractionUserAnswerSchema,
  pendingInteractionUserQuestionQuestionSchema,
  promptTextMentionSchema,
  systemMessageKindSchema,
  systemMessageSubjectSchema,
  threadEventItemPresentationSchema,
  threadEventPlanStepSchema,
  threadEventSearchModeSchema,
  threadTurnInitiatorSchema,
  workflowProgressSnapshotSchema,
  type JsonObject,
  type ThreadEventItemPresentation,
} from "@bb/domain";

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

export const timelineConversationTurnRequestKindValues = [
  "message",
  "steer",
] as const;
export const timelineConversationTurnRequestStatusValues = [
  "pending",
  "accepted",
  "rejected",
] as const;
export const timelineConversationTurnRequestSchema = z.object({
  isGrouped: z.boolean(),
  kind: z.enum(timelineConversationTurnRequestKindValues),
  status: z.enum(timelineConversationTurnRequestStatusValues),
});
export type TimelineConversationTurnRequest = z.infer<
  typeof timelineConversationTurnRequestSchema
>;

const timelineConversationRowBaseSchema = timelineRowBaseSchema.extend({
  kind: z.literal("conversation"),
  text: z.string(),
  attachments: timelineConversationAttachmentsSchema.nullable(),
});

export const timelineUserConversationRowSchema =
  timelineConversationRowBaseSchema.extend({
    role: z.literal("user"),
    initiator: threadTurnInitiatorSchema,
    senderThreadId: z.string().nullable(),
    systemMessageKind: systemMessageKindSchema,
    systemMessageSubject: systemMessageSubjectSchema.nullable(),
    turnRequest: timelineConversationTurnRequestSchema,
    mentions: z.array(promptTextMentionSchema),
  });
export type TimelineUserConversationRow = z.infer<
  typeof timelineUserConversationRowSchema
>;

export const timelineAssistantConversationRowSchema =
  timelineConversationRowBaseSchema.extend({
    role: z.literal("assistant"),
    turnRequest: z.null(),
  });

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
  "context-clear",
  "parent-change",
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
  "context-clear",
  "thread-provisioning",
  "thread-interrupted",
  "provider-unhandled",
  "warning",
  "deprecation",
] as const);

export const timelineParentChangeActionValues = [
  "assign",
  "release",
  "transfer",
] as const;
export const timelineParentChangeActionSchema = z.enum(
  timelineParentChangeActionValues,
);

export const timelineParentChangeSchema = z.object({
  action: timelineParentChangeActionSchema,
  previousParentThreadId: z.string().nullable(),
  previousParentThreadTitle: z.string().nullable(),
  nextParentThreadId: z.string().nullable(),
  nextParentThreadTitle: z.string().nullable(),
});
export type TimelineParentChange = z.infer<typeof timelineParentChangeSchema>;

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

export const timelineParentChangeSystemRowSchema =
  timelineSystemRowBaseSchema.extend({
    systemKind: z.literal("operation"),
    operationKind: z.literal("parent-change"),
    status: timelineRowStatusSchema,
    parentChange: timelineParentChangeSchema,
    completedAt: z.number().nullable(),
  });
export type TimelineParentChangeSystemRow = z.infer<
  typeof timelineParentChangeSystemRowSchema
>;

export const timelineOperationSystemRowSchema = z.discriminatedUnion(
  "operationKind",
  [
    timelineGenericOperationSystemRowSchema,
    timelineParentChangeSystemRowSchema,
  ],
);

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

export const timelineRowPresentationSchema = threadEventItemPresentationSchema;
export type TimelineRowPresentation = ThreadEventItemPresentation;

const timelineRowPresentationField = {
  presentation: timelineRowPresentationSchema.optional(),
};

export const timelineOutputPreviewSchema = z.object({
  totalChars: z.number().int().nonnegative(),
});

export const timelineCommandWorkRowSchema = timelineWorkRowBaseSchema.extend({
  workKind: z.literal("command"),
  callId: z.string(),
  command: z.string(),
  cwd: z.string().nullable(),
  source: z.string().nullable(),
  output: z.string(),
  outputPreview: timelineOutputPreviewSchema.optional(),
  exitCode: z.number().nullable(),
  completedAt: z.number().nullable(),
  approvalStatus: timelineApprovalStatusSchema,
  activityIntents: z.array(timelineActivityIntentSchema),
  ...timelineRowPresentationField,
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
  outputPreview: timelineOutputPreviewSchema.optional(),
  completedAt: z.number().nullable(),
  approvalStatus: timelineApprovalStatusSchema,
  ...timelineRowPresentationField,
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
    ...timelineRowPresentationField,
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
  ...timelineRowPresentationField,
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
  ...timelineRowPresentationField,
});
export type TimelineWebFetchWorkRow = z.infer<
  typeof timelineWebFetchWorkRowSchema
>;

export const timelineImageViewWorkRowSchema = timelineWorkRowBaseSchema.extend({
  workKind: z.literal("image-view"),
  callId: z.string(),
  path: z.string(),
  completedAt: z.number().nullable(),
  ...timelineRowPresentationField,
});
export type TimelineImageViewWorkRow = z.infer<
  typeof timelineImageViewWorkRowSchema
>;

export const timelineFileReadWorkRowSchema = timelineWorkRowBaseSchema.extend({
  workKind: z.literal("file-read"),
  callId: z.string(),
  path: z.string(),
  cmd: z.string().nullable(),
  completedAt: z.number().nullable(),
  ...timelineRowPresentationField,
});
export type TimelineFileReadWorkRow = z.infer<
  typeof timelineFileReadWorkRowSchema
>;

export const timelineSearchWorkRowSchema = timelineWorkRowBaseSchema.extend({
  workKind: z.literal("search"),
  callId: z.string(),
  mode: threadEventSearchModeSchema,
  query: z.string(),
  path: z.string().nullable(),
  cmd: z.string().nullable(),
  completedAt: z.number().nullable(),
  ...timelineRowPresentationField,
});
export type TimelineSearchWorkRow = z.infer<typeof timelineSearchWorkRowSchema>;

export const timelinePlanStepsWorkRowSchema = timelineWorkRowBaseSchema.extend({
  workKind: z.literal("plan-steps"),
  callId: z.string(),
  steps: z.array(threadEventPlanStepSchema),
  explanation: z.string().nullable(),
  completedAt: z.number().nullable(),
  ...timelineRowPresentationField,
});
export type TimelinePlanStepsWorkRow = z.infer<
  typeof timelinePlanStepsWorkRowSchema
>;

export const timelineExtensionWorkRowSchema = timelineWorkRowBaseSchema.extend({
  workKind: z.literal("extension"),
  callId: z.string(),
  extensionKind: extensionKindSchema,
  payload: jsonValueSchema,
  completedAt: z.number().nullable(),
  presentation: timelineRowPresentationSchema,
});
export type TimelineExtensionWorkRow = z.infer<
  typeof timelineExtensionWorkRowSchema
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
] as const;
export const timelineQuestionLifecycleValues = [
  "pending",
  "resolving",
  "answered",
  "interrupted",
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

export const timelineQuestionWorkRowSchema = timelineWorkRowBaseSchema.extend({
  workKind: z.literal("question"),
  interactionId: z.string(),
  lifecycle: z.enum(timelineQuestionLifecycleValues),
  questions: z.array(pendingInteractionUserQuestionQuestionSchema),
  answers: z.record(z.string(), pendingInteractionUserAnswerSchema).nullable(),
  statusReason: z.string().nullable(),
});
export type TimelineQuestionWorkRow = z.infer<
  typeof timelineQuestionWorkRowSchema
>;

export interface TimelineDelegationWorkRow extends TimelineWorkRowBase {
  workKind: "delegation";
  callId: string;
  toolName: string;
  childRef: string | null;
  background: boolean;
  subagentType: string | null;
  description: string | null;
  output: string;
  completedAt: number | null;
  childRows: TimelineRow[];
  presentation?: TimelineRowPresentation;
}

export const timelineDelegationWorkRowSchema: z.ZodType<TimelineDelegationWorkRow> =
  timelineWorkRowBaseSchema.extend({
    workKind: z.literal("delegation"),
    callId: z.string(),
    toolName: z.string(),
    childRef: z.string().nullable(),
    background: z.boolean(),
    subagentType: z.string().nullable(),
    description: z.string().nullable(),
    output: z.string(),
    completedAt: z.number().nullable(),
    childRows: z.array(z.lazy(() => timelineRowSchema)),
    ...timelineRowPresentationField,
  });

export const timelineWorkflowWorkRowSchema = timelineWorkRowBaseSchema.extend({
  workKind: z.literal("workflow"),
  itemId: z.string(),
  taskType: z.string(),
  workflowName: z.string().nullable(),
  description: z.string(),
  model: z.string().nullable(),
  taskStatus: backgroundTaskStatusSchema,
  workflow: workflowProgressSnapshotSchema.nullable(),
  usage: backgroundTaskUsageSchema.nullable(),
  summary: z.string().nullable(),
  error: z.string().nullable(),
  completedAt: z.number().nullable(),
  ...timelineRowPresentationField,
});
export type TimelineWorkflowWorkRow = z.infer<
  typeof timelineWorkflowWorkRowSchema
>;

export type TimelineWorkRow =
  | TimelineCommandWorkRow
  | TimelineToolWorkRow
  | TimelineFileChangeWorkRow
  | TimelineWebSearchWorkRow
  | TimelineWebFetchWorkRow
  | TimelineImageViewWorkRow
  | TimelineFileReadWorkRow
  | TimelineSearchWorkRow
  | TimelinePlanStepsWorkRow
  | TimelineExtensionWorkRow
  | TimelineApprovalWorkRow
  | TimelineQuestionWorkRow
  | TimelineDelegationWorkRow
  | TimelineWorkflowWorkRow;

export const timelineWorkRowSchema: z.ZodType<TimelineWorkRow> = z.union([
  timelineCommandWorkRowSchema,
  timelineToolWorkRowSchema,
  timelineFileChangeWorkRowSchema,
  timelineWebSearchWorkRowSchema,
  timelineWebFetchWorkRowSchema,
  timelineImageViewWorkRowSchema,
  timelineFileReadWorkRowSchema,
  timelineSearchWorkRowSchema,
  timelinePlanStepsWorkRowSchema,
  timelineExtensionWorkRowSchema,
  timelineApprovalWorkRowSchema,
  timelineQuestionWorkRowSchema,
  timelineDelegationWorkRowSchema,
  timelineWorkflowWorkRowSchema,
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

export const timelineRowSchema: z.ZodType<TimelineRow> = z.lazy(() =>
  z.union([
    timelineConversationRowSchema,
    timelineWorkRowSchema,
    timelineSystemRowSchema,
    timelineTurnRowSchema,
  ]),
);

export type TimelineToolArgs = JsonObject | null;

export const timelineDeltaSchema = z.object({
  upsertRows: z.array(timelineRowSchema),
  rowOrder: z.array(z.string()).optional(),
});
export type TimelineDelta = z.infer<typeof timelineDeltaSchema>;

export function computeTimelineRowDelta(
  prevRows: readonly TimelineRow[],
  currentRows: readonly TimelineRow[],
): TimelineDelta {
  const prevById = new Map<string, string>();
  for (const row of prevRows) {
    prevById.set(row.id, JSON.stringify(row));
  }
  const upsertRows: TimelineRow[] = [];
  const rowOrder: string[] = [];
  let orderChanged = prevRows.length !== currentRows.length;
  for (const row of currentRows) {
    rowOrder.push(row.id);
    if (prevRows[rowOrder.length - 1]?.id !== row.id) {
      orderChanged = true;
    }
    if (prevById.get(row.id) !== JSON.stringify(row)) {
      upsertRows.push(row);
    }
  }
  return orderChanged ? { upsertRows, rowOrder } : { upsertRows };
}

export function applyTimelineDelta(
  prevRows: readonly TimelineRow[],
  delta: TimelineDelta,
): TimelineRow[] | null {
  const byId = new Map<string, TimelineRow>();
  for (const row of prevRows) {
    byId.set(row.id, row);
  }
  for (const row of delta.upsertRows) {
    byId.set(row.id, row);
  }
  const result: TimelineRow[] = [];
  const rowOrder = delta.rowOrder ?? prevRows.map((row) => row.id);
  for (const id of rowOrder) {
    const row = byId.get(id);
    if (row === undefined) {
      return null;
    }
    result.push(row);
  }
  return result;
}
