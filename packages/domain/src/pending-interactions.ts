import { z } from "zod";

export const pendingInteractionStatusSchema = z.enum([
  "pending",
  "resolving",
  "resolved",
  "interrupted",
  "expired",
]);
export type PendingInteractionStatus = z.infer<
  typeof pendingInteractionStatusSchema
>;

export const pendingInteractionCommandActionSchema = z.discriminatedUnion(
  "type",
  [
    z.object({
      type: z.literal("read"),
      command: z.string(),
      name: z.string(),
      path: z.string(),
    }),
    z.object({
      type: z.literal("listFiles"),
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
  ],
);
export type PendingInteractionCommandAction = z.infer<
  typeof pendingInteractionCommandActionSchema
>;

export const pendingInteractionNetworkPermissionsSchema = z.object({
  enabled: z.boolean().nullable(),
});
export type PendingInteractionNetworkPermissions = z.infer<
  typeof pendingInteractionNetworkPermissionsSchema
>;

export const pendingInteractionFileSystemPermissionsSchema = z.object({
  read: z.array(z.string()),
  write: z.array(z.string()),
});
export type PendingInteractionFileSystemPermissions = z.infer<
  typeof pendingInteractionFileSystemPermissionsSchema
>;

const pendingInteractionMacOsPreferencesPermissionSchema = z.enum([
  "none",
  "read_only",
  "read_write",
]);
export type PendingInteractionMacOsPreferencesPermission = z.infer<
  typeof pendingInteractionMacOsPreferencesPermissionSchema
>;

const pendingInteractionMacOsContactsPermissionSchema = z.enum([
  "none",
  "read_only",
  "read_write",
]);
export type PendingInteractionMacOsContactsPermission = z.infer<
  typeof pendingInteractionMacOsContactsPermissionSchema
>;

const pendingInteractionMacOsAutomationPermissionSchema = z.union([
  z.literal("none"),
  z.literal("all"),
  z.object({
    kind: z.literal("bundle_ids"),
    bundleIds: z.array(z.string()),
  }),
]);
export type PendingInteractionMacOsAutomationPermission = z.infer<
  typeof pendingInteractionMacOsAutomationPermissionSchema
>;

export const pendingInteractionMacOsPermissionsSchema = z.object({
  preferences: pendingInteractionMacOsPreferencesPermissionSchema,
  automations: pendingInteractionMacOsAutomationPermissionSchema,
  launchServices: z.boolean(),
  accessibility: z.boolean(),
  calendar: z.boolean(),
  reminders: z.boolean(),
  contacts: pendingInteractionMacOsContactsPermissionSchema,
});
export type PendingInteractionMacOsPermissions = z.infer<
  typeof pendingInteractionMacOsPermissionsSchema
>;

export const pendingInteractionRequestedPermissionProfileSchema = z.object({
  network: pendingInteractionNetworkPermissionsSchema.nullable(),
  fileSystem: pendingInteractionFileSystemPermissionsSchema.nullable(),
  macos: pendingInteractionMacOsPermissionsSchema.nullable(),
});
export type PendingInteractionRequestedPermissionProfile = z.infer<
  typeof pendingInteractionRequestedPermissionProfileSchema
>;

export const pendingInteractionGrantablePermissionProfileSchema = z
  .object({
    network: pendingInteractionNetworkPermissionsSchema.nullable(),
    fileSystem: pendingInteractionFileSystemPermissionsSchema.nullable(),
  })
  .strict();
export type PendingInteractionGrantablePermissionProfile = z.infer<
  typeof pendingInteractionGrantablePermissionProfileSchema
>;

const pendingInteractionGrantedPermissionProfileSchema =
  pendingInteractionGrantablePermissionProfileSchema;
export type PendingInteractionGrantedPermissionProfile = z.infer<
  typeof pendingInteractionGrantedPermissionProfileSchema
>;

export const pendingInteractionApprovalDecisionSchema = z.enum([
  "allow_once",
  "allow_for_session",
  "deny",
]);
export type PendingInteractionApprovalDecision = z.infer<
  typeof pendingInteractionApprovalDecisionSchema
>;

export const pendingInteractionFileChangeWriteScopeSchema = z.string().min(1);
export type PendingInteractionFileChangeWriteScope = z.infer<
  typeof pendingInteractionFileChangeWriteScopeSchema
>;

export const pendingInteractionCommandApprovalSubjectSchema = z.object({
  kind: z.literal("command"),
  itemId: z.string().min(1),
  command: z.string().min(1),
  cwd: z.string().nullable(),
  actions: z.array(pendingInteractionCommandActionSchema),
  sessionGrant: pendingInteractionGrantablePermissionProfileSchema.nullable(),
});
export type PendingInteractionCommandApprovalSubject = z.infer<
  typeof pendingInteractionCommandApprovalSubjectSchema
>;

export const pendingInteractionFileChangeApprovalSubjectSchema = z.object({
  kind: z.literal("file_change"),
  itemId: z.string().min(1),
  writeScope: pendingInteractionFileChangeWriteScopeSchema.nullable(),
  sessionGrant: pendingInteractionGrantablePermissionProfileSchema.nullable(),
});
export type PendingInteractionFileChangeApprovalSubject = z.infer<
  typeof pendingInteractionFileChangeApprovalSubjectSchema
>;

export const pendingInteractionPermissionGrantApprovalSubjectSchema = z.object({
  kind: z.literal("permission_grant"),
  itemId: z.string().min(1),
  toolName: z.string().nullable(),
  permissions: pendingInteractionGrantablePermissionProfileSchema,
});
export type PendingInteractionPermissionGrantApprovalSubject = z.infer<
  typeof pendingInteractionPermissionGrantApprovalSubjectSchema
>;

export const pendingInteractionApprovalSubjectSchema = z.discriminatedUnion(
  "kind",
  [
    pendingInteractionCommandApprovalSubjectSchema,
    pendingInteractionFileChangeApprovalSubjectSchema,
    pendingInteractionPermissionGrantApprovalSubjectSchema,
  ],
);
export type PendingInteractionApprovalSubject = z.infer<
  typeof pendingInteractionApprovalSubjectSchema
>;

export const approvalPendingInteractionPayloadSchema = z.object({
  kind: z.literal("approval"),
  subject: pendingInteractionApprovalSubjectSchema,
  reason: z.string().nullable(),
  availableDecisions: z.array(pendingInteractionApprovalDecisionSchema).min(1),
});
export type ApprovalPendingInteractionPayload = z.infer<
  typeof approvalPendingInteractionPayloadSchema
>;

export const USER_QUESTION_MAX_QUESTIONS = 4;
export const USER_QUESTION_MAX_OPTIONS = 4;
export const USER_QUESTION_MAX_SELECTED = 4;
export const USER_QUESTION_MAX_FREE_TEXT_LENGTH = 4096;

const pendingInteractionUserQuestionIdSchema = z
  .string()
  .min(1)
  .refine((value) => value.trim().length > 0, {
    message: "User question ids cannot be blank",
  });

const pendingInteractionUserQuestionPromptSchema = z
  .string()
  .min(1)
  .refine((value) => value.trim().length > 0, {
    message: "User question prompts cannot be blank",
  });

const pendingInteractionUserQuestionShortLabelSchema = z
  .string()
  .min(1)
  .refine((value) => value.trim().length > 0, {
    message: "User question short labels cannot be blank",
  });

const pendingInteractionUserQuestionOptionValueSchema = z
  .string()
  .min(1)
  .refine((value) => value.trim().length > 0, {
    message: "User question option values cannot be blank",
  });

const pendingInteractionUserQuestionOptionLabelSchema = z
  .string()
  .min(1)
  .refine((value) => value.trim().length > 0, {
    message: "User question option labels cannot be blank",
  });

const pendingInteractionUserQuestionOptionDescriptionSchema = z
  .string()
  .min(1)
  .refine((value) => value.trim().length > 0, {
    message: "User question option descriptions cannot be blank",
  });

const pendingInteractionUserQuestionFreeTextSchema = z
  .string()
  .min(1)
  .max(
    USER_QUESTION_MAX_FREE_TEXT_LENGTH,
    `User question free text cannot exceed ${USER_QUESTION_MAX_FREE_TEXT_LENGTH} characters`,
  )
  .refine((value) => value.trim().length > 0, {
    message: "User question free text cannot be blank",
  });

export const pendingInteractionUserQuestionOptionSchema = z.object({
  value: pendingInteractionUserQuestionOptionValueSchema,
  label: pendingInteractionUserQuestionOptionLabelSchema,
  description: pendingInteractionUserQuestionOptionDescriptionSchema.optional(),
});
export type PendingInteractionUserQuestionOption = z.infer<
  typeof pendingInteractionUserQuestionOptionSchema
>;

export const pendingInteractionUserQuestionQuestionSchema = z
  .object({
    id: pendingInteractionUserQuestionIdSchema,
    prompt: pendingInteractionUserQuestionPromptSchema,
    shortLabel: pendingInteractionUserQuestionShortLabelSchema.optional(),
    multiSelect: z.boolean(),
    options: z
      .array(pendingInteractionUserQuestionOptionSchema)
      .max(
        USER_QUESTION_MAX_OPTIONS,
        `User questions cannot include more than ${USER_QUESTION_MAX_OPTIONS} options`,
      )
      .optional(),
    allowFreeText: z.boolean(),
  })
  .superRefine((question, context) => {
    const optionValues = new Set<string>();
    question.options?.forEach((option, index) => {
      if (optionValues.has(option.value)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "User question option values must be unique",
          path: ["options", index, "value"],
        });
        return;
      }
      optionValues.add(option.value);
    });
  })
  .refine(
    (question) =>
      question.allowFreeText || (question.options?.length ?? 0) > 0,
    {
      message:
        "User questions must allow free text or provide at least one option",
      path: ["options"],
    },
  );
export type PendingInteractionUserQuestionQuestion = z.infer<
  typeof pendingInteractionUserQuestionQuestionSchema
>;

export const userQuestionPendingInteractionPayloadSchema = z
  .object({
    kind: z.literal("user_question"),
    questions: z
      .array(pendingInteractionUserQuestionQuestionSchema)
      .min(1)
      .max(
        USER_QUESTION_MAX_QUESTIONS,
        `User questions cannot include more than ${USER_QUESTION_MAX_QUESTIONS} questions`,
      ),
  })
  .superRefine((payload, context) => {
    const questionIds = new Set<string>();
    payload.questions.forEach((question, index) => {
      if (questionIds.has(question.id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "User question ids must be unique",
          path: ["questions", index, "id"],
        });
        return;
      }
      questionIds.add(question.id);
    });
  });
export type UserQuestionPendingInteractionPayload = z.infer<
  typeof userQuestionPendingInteractionPayloadSchema
>;

export const pendingInteractionPayloadSchema = z.discriminatedUnion("kind", [
  approvalPendingInteractionPayloadSchema,
  userQuestionPendingInteractionPayloadSchema,
]);
export type PendingInteractionPayload = z.infer<
  typeof pendingInteractionPayloadSchema
>;

export function isApprovalPendingInteractionPayload(
  payload: PendingInteractionPayload,
): payload is ApprovalPendingInteractionPayload {
  return payload.kind === "approval";
}

export function isUserQuestionPendingInteractionPayload(
  payload: PendingInteractionPayload,
): payload is UserQuestionPendingInteractionPayload {
  return payload.kind === "user_question";
}

const approvalDecisionDiscriminatorError =
  "Invalid discriminator value. Expected 'allow_once' | 'allow_for_session' | 'deny'";

export const approvalPendingInteractionResolutionSchema = z.discriminatedUnion(
  "decision",
  [
    z.object({
      decision: z.literal("allow_once"),
      grantedPermissions:
        pendingInteractionGrantedPermissionProfileSchema.nullable(),
    }),
    z.object({
      decision: z.literal("allow_for_session"),
      grantedPermissions:
        pendingInteractionGrantedPermissionProfileSchema.nullable(),
    }),
    z.object({
      decision: z.literal("deny"),
    }),
  ],
  approvalDecisionDiscriminatorError,
);
export type ApprovalPendingInteractionResolution = z.infer<
  typeof approvalPendingInteractionResolutionSchema
>;

export const pendingInteractionUserAnswerSchema = z
  .object({
    selected: z
      .array(z.string().min(1))
      .max(
        USER_QUESTION_MAX_SELECTED,
        `User question selected choices cannot exceed ${USER_QUESTION_MAX_SELECTED}`,
      ),
    freeText: pendingInteractionUserQuestionFreeTextSchema.optional(),
  });
export type PendingInteractionUserAnswer = z.infer<
  typeof pendingInteractionUserAnswerSchema
>;

export const userQuestionPendingInteractionResolutionSchema = z.object({
  kind: z.literal("user_answer"),
  answers: z.record(z.string().min(1), pendingInteractionUserAnswerSchema),
});
export type UserQuestionPendingInteractionResolution = z.infer<
  typeof userQuestionPendingInteractionResolutionSchema
>;

export const pendingInteractionResolutionSchema = z.union(
  [
    approvalPendingInteractionResolutionSchema,
    userQuestionPendingInteractionResolutionSchema,
  ],
  approvalDecisionDiscriminatorError,
);
export type PendingInteractionResolution = z.infer<
  typeof pendingInteractionResolutionSchema
>;

export function isApprovalPendingInteractionResolution(
  resolution: PendingInteractionResolution,
): resolution is ApprovalPendingInteractionResolution {
  return "decision" in resolution;
}

export function isUserQuestionPendingInteractionResolution(
  resolution: PendingInteractionResolution,
): resolution is UserQuestionPendingInteractionResolution {
  return "kind" in resolution && resolution.kind === "user_answer";
}

export const pendingInteractionCreateSchema = z.object({
  threadId: z.string().min(1),
  turnId: z.string().min(1),
  providerId: z.string().min(1),
  providerThreadId: z.string().min(1),
  providerRequestId: z.string().min(1),
  payload: pendingInteractionPayloadSchema,
});
export type PendingInteractionCreate = z.infer<
  typeof pendingInteractionCreateSchema
>;

export const pendingInteractionSchema = z.object({
  id: z.string().min(1),
  threadId: z.string().min(1),
  turnId: z.string().min(1),
  providerId: z.string().min(1),
  providerThreadId: z.string().min(1),
  providerRequestId: z.string().min(1),
  status: pendingInteractionStatusSchema,
  payload: pendingInteractionPayloadSchema,
  resolution: pendingInteractionResolutionSchema.nullable(),
  statusReason: z.string().nullable(),
  createdAt: z.number().int().nonnegative(),
  resolvedAt: z.number().int().nonnegative().nullable(),
});
export type PendingInteraction = z.infer<typeof pendingInteractionSchema>;
