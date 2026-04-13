import { z } from "zod";

export const pendingInteractionKindSchema = z.enum([
  "approval",
]);
export type PendingInteractionKind = z.infer<
  typeof pendingInteractionKindSchema
>;

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

export const pendingInteractionGrantablePermissionProfileSchema = z.object({
  network: pendingInteractionNetworkPermissionsSchema.nullable(),
  fileSystem: pendingInteractionFileSystemPermissionsSchema.nullable(),
}).strict();
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

export const pendingInteractionPermissionGrantScopeSchema = z.enum([
  "turn",
  "session",
]);
export type PendingInteractionPermissionGrantScope = z.infer<
  typeof pendingInteractionPermissionGrantScopeSchema
>;

export const pendingInteractionFileChangeWriteScopeSchema = z.object({
  root: z.string().min(1),
});
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

export const pendingInteractionApprovalSubjectSchema = z.discriminatedUnion("kind", [
  pendingInteractionCommandApprovalSubjectSchema,
  pendingInteractionFileChangeApprovalSubjectSchema,
  pendingInteractionPermissionGrantApprovalSubjectSchema,
]);
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

export const pendingInteractionPayloadSchema = z.discriminatedUnion("kind", [
  approvalPendingInteractionPayloadSchema,
]);
export type PendingInteractionPayload = z.infer<
  typeof pendingInteractionPayloadSchema
>;

export const approvalPendingInteractionResolutionSchema =
  z.discriminatedUnion("decision", [
    z.object({
      kind: z.literal("approval"),
      decision: z.literal("allow_once"),
      grantedPermissions: pendingInteractionGrantedPermissionProfileSchema.nullable(),
    }),
    z.object({
      kind: z.literal("approval"),
      decision: z.literal("allow_for_session"),
      grantedPermissions: pendingInteractionGrantedPermissionProfileSchema.nullable(),
    }),
    z.object({
      kind: z.literal("approval"),
      decision: z.literal("deny"),
    }),
  ]);
export type ApprovalPendingInteractionResolution = z.infer<
  typeof approvalPendingInteractionResolutionSchema
>;

export const pendingInteractionResolutionSchema =
  approvalPendingInteractionResolutionSchema;
export type PendingInteractionResolution = z.infer<
  typeof pendingInteractionResolutionSchema
>;

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
}).superRefine((value, context) => {
  if (value.resolution !== null && value.resolution.kind !== value.payload.kind) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "resolution kind must match payload kind",
      path: ["resolution", "kind"],
    });
  }
});
export type PendingInteraction = z.infer<typeof pendingInteractionSchema>;
