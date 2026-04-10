import { z } from "zod";

export const pendingInteractionKindSchema = z.enum([
  "command_approval",
  "file_change_approval",
  "permission_request",
]);
export type PendingInteractionKind = z.infer<
  typeof pendingInteractionKindSchema
>;

export const pendingInteractionStatusSchema = z.enum([
  "pending",
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

const pendingInteractionCommandApprovalSimpleDecisionSchema = z.enum([
  "accept",
  "accept_for_session",
  "decline",
  "cancel",
]);
export type PendingInteractionCommandApprovalSimpleDecision = z.infer<
  typeof pendingInteractionCommandApprovalSimpleDecisionSchema
>;

const pendingInteractionNetworkPolicyRuleActionSchema = z.enum([
  "allow",
  "deny",
]);
export type PendingInteractionNetworkPolicyRuleAction = z.infer<
  typeof pendingInteractionNetworkPolicyRuleActionSchema
>;

const pendingInteractionExecPolicyAmendmentSchema = z.array(z.string());
export type PendingInteractionExecPolicyAmendment = z.infer<
  typeof pendingInteractionExecPolicyAmendmentSchema
>;

const pendingInteractionNetworkPolicyAmendmentSchema = z.object({
  host: z.string(),
  action: pendingInteractionNetworkPolicyRuleActionSchema,
});
export type PendingInteractionNetworkPolicyAmendment = z.infer<
  typeof pendingInteractionNetworkPolicyAmendmentSchema
>;

const pendingInteractionExecPolicyAmendmentDecisionSchema = z.object({
  kind: z.literal("accept_with_exec_policy_amendment"),
  execPolicyAmendment: pendingInteractionExecPolicyAmendmentSchema,
});
export type PendingInteractionExecPolicyAmendmentDecision = z.infer<
  typeof pendingInteractionExecPolicyAmendmentDecisionSchema
>;

const pendingInteractionNetworkPolicyAmendmentDecisionSchema = z.object({
  kind: z.literal("apply_network_policy_amendment"),
  networkPolicyAmendment: pendingInteractionNetworkPolicyAmendmentSchema,
});
export type PendingInteractionNetworkPolicyAmendmentDecision = z.infer<
  typeof pendingInteractionNetworkPolicyAmendmentDecisionSchema
>;

const pendingInteractionCommandApprovalDecisionSchema = z.union([
  pendingInteractionCommandApprovalSimpleDecisionSchema,
  pendingInteractionExecPolicyAmendmentDecisionSchema,
  pendingInteractionNetworkPolicyAmendmentDecisionSchema,
]);
export type PendingInteractionCommandApprovalDecision = z.infer<
  typeof pendingInteractionCommandApprovalDecisionSchema
>;

const pendingInteractionFileChangeApprovalDecisionSchema = z.enum([
  "accept",
  "accept_for_session",
  "decline",
  "cancel",
]);
export type PendingInteractionFileChangeApprovalDecision = z.infer<
  typeof pendingInteractionFileChangeApprovalDecisionSchema
>;

export const pendingInteractionPermissionGrantScopeSchema = z.enum([
  "turn",
  "session",
]);
export type PendingInteractionPermissionGrantScope = z.infer<
  typeof pendingInteractionPermissionGrantScopeSchema
>;

const pendingInteractionPermissionDecisionSchema = z.enum([
  "allow",
  "deny",
]);
export type PendingInteractionPermissionDecision = z.infer<
  typeof pendingInteractionPermissionDecisionSchema
>;

export const commandApprovalPendingInteractionPayloadSchema = z.object({
  kind: z.literal("command_approval"),
  itemId: z.string().min(1),
  reason: z.string().nullable(),
  command: z.string().nullable(),
  cwd: z.string().nullable(),
  commandActions: z.array(pendingInteractionCommandActionSchema),
  requestedPermissions: pendingInteractionRequestedPermissionProfileSchema.nullable(),
  availableDecisions: z.array(pendingInteractionCommandApprovalDecisionSchema),
});
export type CommandApprovalPendingInteractionPayload = z.infer<
  typeof commandApprovalPendingInteractionPayloadSchema
>;

export const fileChangeApprovalPendingInteractionPayloadSchema = z.object({
  kind: z.literal("file_change_approval"),
  itemId: z.string().min(1),
  reason: z.string().nullable(),
  grantRoot: z.string().nullable(),
});
export type FileChangeApprovalPendingInteractionPayload = z.infer<
  typeof fileChangeApprovalPendingInteractionPayloadSchema
>;

export const permissionRequestPendingInteractionPayloadSchema = z.object({
  kind: z.literal("permission_request"),
  itemId: z.string().min(1),
  reason: z.string().nullable(),
  toolName: z.string().nullable(),
  permissions: pendingInteractionGrantablePermissionProfileSchema,
});
export type PermissionRequestPendingInteractionPayload = z.infer<
  typeof permissionRequestPendingInteractionPayloadSchema
>;

export const pendingInteractionPayloadSchema = z.discriminatedUnion("kind", [
  commandApprovalPendingInteractionPayloadSchema,
  fileChangeApprovalPendingInteractionPayloadSchema,
  permissionRequestPendingInteractionPayloadSchema,
]);
export type PendingInteractionPayload = z.infer<
  typeof pendingInteractionPayloadSchema
>;

export const commandApprovalPendingInteractionResolutionSchema = z.object({
  kind: z.literal("command_approval"),
  decision: pendingInteractionCommandApprovalDecisionSchema,
});
export type CommandApprovalPendingInteractionResolution = z.infer<
  typeof commandApprovalPendingInteractionResolutionSchema
>;

export const fileChangeApprovalPendingInteractionResolutionSchema = z.object({
  kind: z.literal("file_change_approval"),
  decision: pendingInteractionFileChangeApprovalDecisionSchema,
});
export type FileChangeApprovalPendingInteractionResolution = z.infer<
  typeof fileChangeApprovalPendingInteractionResolutionSchema
>;

export const permissionRequestPendingInteractionResolutionSchema =
  z.discriminatedUnion("decision", [
    z.object({
      kind: z.literal("permission_request"),
      decision: z.literal("allow"),
      permissions: pendingInteractionGrantedPermissionProfileSchema,
      scope: pendingInteractionPermissionGrantScopeSchema,
    }),
    z.object({
      kind: z.literal("permission_request"),
      decision: z.literal("deny"),
    }),
  ]);
export type PermissionRequestPendingInteractionResolution = z.infer<
  typeof permissionRequestPendingInteractionResolutionSchema
>;

export const pendingInteractionResolutionSchema = z.union([
  commandApprovalPendingInteractionResolutionSchema,
  fileChangeApprovalPendingInteractionResolutionSchema,
  permissionRequestPendingInteractionResolutionSchema,
]);
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
