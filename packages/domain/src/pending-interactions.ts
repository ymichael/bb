import { z } from "zod";

export const pendingInteractionKindSchema = z.enum([
  "command_approval",
  "file_change_approval",
  "permission_request",
  "user_input_request",
]);
export type PendingInteractionKind = z.infer<
  typeof pendingInteractionKindSchema
>;

export const pendingInteractionStatusSchema = z.enum([
  "pending",
  "resolved",
  "rejected",
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

export const pendingInteractionMacOsPreferencesPermissionSchema = z.enum([
  "none",
  "read_only",
  "read_write",
]);
export type PendingInteractionMacOsPreferencesPermission = z.infer<
  typeof pendingInteractionMacOsPreferencesPermissionSchema
>;

export const pendingInteractionMacOsContactsPermissionSchema = z.enum([
  "none",
  "read_only",
  "read_write",
]);
export type PendingInteractionMacOsContactsPermission = z.infer<
  typeof pendingInteractionMacOsContactsPermissionSchema
>;

export const pendingInteractionMacOsAutomationPermissionSchema = z.union([
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

export interface PendingInteractionPermissionProfileInput {
  network: PendingInteractionPermissionNetworkInput | null | undefined;
  fileSystem: PendingInteractionPermissionFileSystemInput | null | undefined;
  macos: PendingInteractionPermissionMacOsInput | null | undefined;
}

export interface PendingInteractionPermissionNetworkInput {
  enabled: boolean | null | undefined;
}

export interface PendingInteractionPermissionFileSystemInput {
  read: string[] | null | undefined;
  write: string[] | null | undefined;
}

export interface PendingInteractionPermissionMacOsBundleIdsInput {
  bundleIds: string[] | null | undefined;
}

export type PendingInteractionPermissionMacOsAutomationInput =
  | "none"
  | "all"
  | PendingInteractionPermissionMacOsBundleIdsInput;

export interface PendingInteractionPermissionMacOsInput {
  preferences: PendingInteractionMacOsPreferencesPermission | null | undefined;
  automations: PendingInteractionPermissionMacOsAutomationInput | null | undefined;
  launchServices: boolean | null | undefined;
  accessibility: boolean | null | undefined;
  calendar: boolean | null | undefined;
  reminders: boolean | null | undefined;
  contacts: PendingInteractionMacOsContactsPermission | null | undefined;
}

function normalizePendingInteractionMacOsAutomationPermission(
  input: PendingInteractionPermissionMacOsAutomationInput | null | undefined,
): PendingInteractionMacOsAutomationPermission {
  if (input === "none" || input === "all") {
    return input;
  }

  return {
    kind: "bundle_ids",
    bundleIds: input?.bundleIds ?? [],
  };
}

export function normalizePendingInteractionRequestedPermissionProfile(
  input: PendingInteractionPermissionProfileInput,
): PendingInteractionRequestedPermissionProfile {
  return pendingInteractionRequestedPermissionProfileSchema.parse({
    network: input.network
      ? {
          enabled: input.network.enabled ?? null,
        }
      : null,
    fileSystem: input.fileSystem
      ? {
          read: input.fileSystem.read ?? [],
          write: input.fileSystem.write ?? [],
        }
      : null,
    macos: input.macos
      ? {
          preferences: input.macos.preferences ?? "none",
          automations: normalizePendingInteractionMacOsAutomationPermission(
            input.macos.automations,
          ),
          launchServices: input.macos.launchServices ?? false,
          accessibility: input.macos.accessibility ?? false,
          calendar: input.macos.calendar ?? false,
          reminders: input.macos.reminders ?? false,
          contacts: input.macos.contacts ?? "none",
        }
      : null,
  });
}

export function summarizePendingInteractionRequestedMacOsPermissions(
  permissions: PendingInteractionMacOsPermissions | null,
): string[] {
  if (permissions === null) {
    return [];
  }

  const summaries: string[] = [];
  if (permissions.accessibility) {
    summaries.push("macOS accessibility");
  }
  if (permissions.launchServices) {
    summaries.push("macOS launch services");
  }
  if (permissions.calendar) {
    summaries.push("macOS calendar");
  }
  if (permissions.reminders) {
    summaries.push("macOS reminders");
  }
  if (permissions.preferences !== "none") {
    summaries.push(`macOS preferences (${permissions.preferences.replace("_", " ")})`);
  }
  if (permissions.contacts !== "none") {
    summaries.push(`macOS contacts (${permissions.contacts.replace("_", " ")})`);
  }
  if (permissions.automations === "all") {
    summaries.push("macOS automation (all apps)");
  } else if (
    permissions.automations !== "none"
    && permissions.automations.bundleIds.length > 0
  ) {
    summaries.push(
      permissions.automations.bundleIds.length === 1
        ? "macOS automation (1 app)"
        : `macOS automation (${permissions.automations.bundleIds.length} apps)`,
    );
  }

  return summaries;
}

export function summarizePendingInteractionRequestedPermissions(
  permissions: PendingInteractionRequestedPermissionProfile,
): string[] {
  const summaries: string[] = [];
  if (permissions.network?.enabled === true) {
    summaries.push("Network access");
  }
  if (permissions.fileSystem) {
    if (permissions.fileSystem.read.length > 0) {
      summaries.push(
        permissions.fileSystem.read.length === 1
          ? "Read 1 path"
          : `Read ${permissions.fileSystem.read.length} paths`,
      );
    }
    if (permissions.fileSystem.write.length > 0) {
      summaries.push(
        permissions.fileSystem.write.length === 1
          ? "Write 1 path"
          : `Write ${permissions.fileSystem.write.length} paths`,
      );
    }
  }

  return [
    ...summaries,
    ...summarizePendingInteractionRequestedMacOsPermissions(permissions.macos),
  ];
}

export const pendingInteractionGrantedPermissionProfileSchema = z.object({
  network: pendingInteractionNetworkPermissionsSchema.nullable(),
  fileSystem: pendingInteractionFileSystemPermissionsSchema.nullable(),
});
export type PendingInteractionGrantedPermissionProfile = z.infer<
  typeof pendingInteractionGrantedPermissionProfileSchema
>;

export const pendingInteractionCommandApprovalSimpleDecisionSchema = z.enum([
  "accept",
  "accept_for_session",
  "decline",
  "cancel",
]);
export type PendingInteractionCommandApprovalSimpleDecision = z.infer<
  typeof pendingInteractionCommandApprovalSimpleDecisionSchema
>;

export const pendingInteractionNetworkPolicyRuleActionSchema = z.enum([
  "allow",
  "deny",
]);
export type PendingInteractionNetworkPolicyRuleAction = z.infer<
  typeof pendingInteractionNetworkPolicyRuleActionSchema
>;

export const pendingInteractionExecPolicyAmendmentSchema = z.array(z.string());
export type PendingInteractionExecPolicyAmendment = z.infer<
  typeof pendingInteractionExecPolicyAmendmentSchema
>;

export const pendingInteractionNetworkPolicyAmendmentSchema = z.object({
  host: z.string(),
  action: pendingInteractionNetworkPolicyRuleActionSchema,
});
export type PendingInteractionNetworkPolicyAmendment = z.infer<
  typeof pendingInteractionNetworkPolicyAmendmentSchema
>;

export const pendingInteractionExecPolicyAmendmentDecisionSchema = z.object({
  kind: z.literal("accept_with_exec_policy_amendment"),
  execPolicyAmendment: pendingInteractionExecPolicyAmendmentSchema,
});
export type PendingInteractionExecPolicyAmendmentDecision = z.infer<
  typeof pendingInteractionExecPolicyAmendmentDecisionSchema
>;

export const pendingInteractionNetworkPolicyAmendmentDecisionSchema = z.object({
  kind: z.literal("apply_network_policy_amendment"),
  networkPolicyAmendment: pendingInteractionNetworkPolicyAmendmentSchema,
});
export type PendingInteractionNetworkPolicyAmendmentDecision = z.infer<
  typeof pendingInteractionNetworkPolicyAmendmentDecisionSchema
>;

export const pendingInteractionCommandApprovalDecisionSchema = z.union([
  pendingInteractionCommandApprovalSimpleDecisionSchema,
  pendingInteractionExecPolicyAmendmentDecisionSchema,
  pendingInteractionNetworkPolicyAmendmentDecisionSchema,
]);
export type PendingInteractionCommandApprovalDecision = z.infer<
  typeof pendingInteractionCommandApprovalDecisionSchema
>;

export type PendingInteractionCommandApprovalDecisionKind =
  | PendingInteractionCommandApprovalSimpleDecision
  | PendingInteractionExecPolicyAmendmentDecision["kind"]
  | PendingInteractionNetworkPolicyAmendmentDecision["kind"];

export function getPendingInteractionCommandApprovalDecisionKind(
  decision: PendingInteractionCommandApprovalDecision,
): PendingInteractionCommandApprovalDecisionKind {
  return typeof decision === "string" ? decision : decision.kind;
}

export function formatPendingInteractionCommandApprovalDecision(
  decision: PendingInteractionCommandApprovalDecision,
): string {
  if (typeof decision === "string") {
    return decision;
  }

  switch (decision.kind) {
    case "accept_with_exec_policy_amendment":
      return `accept_with_exec_policy_amendment(${decision.execPolicyAmendment.join(", ")})`;
    case "apply_network_policy_amendment":
      return `apply_network_policy_amendment(${decision.networkPolicyAmendment.action} ${decision.networkPolicyAmendment.host})`;
  }
}

export function formatPendingInteractionCommandApprovalResolutionOutcome(
  decision: PendingInteractionCommandApprovalDecision,
): string {
  if (typeof decision === "string") {
    switch (decision) {
      case "accept":
        return "approved";
      case "accept_for_session":
        return "approved for this session";
      case "decline":
        return "denied";
      case "cancel":
        return "cancelled";
    }
  }

  switch (decision.kind) {
    case "accept_with_exec_policy_amendment":
      return "approved with exec policy amendment";
    case "apply_network_policy_amendment":
      return "approved with network policy amendment";
  }
}

export function formatPendingInteractionCommandApprovalResolutionMessage(
  decision: PendingInteractionCommandApprovalDecision,
): string {
  if (typeof decision === "string" && decision === "cancel") {
    return "Command request cancelled";
  }

  return `Command ${formatPendingInteractionCommandApprovalResolutionOutcome(decision)}`;
}

export function isPendingInteractionCommandApprovalPositiveDecision(
  decision: PendingInteractionCommandApprovalDecision,
): boolean {
  switch (getPendingInteractionCommandApprovalDecisionKind(decision)) {
    case "accept":
    case "accept_for_session":
    case "accept_with_exec_policy_amendment":
    case "apply_network_policy_amendment":
      return true;
    case "decline":
    case "cancel":
      return false;
  }
}

export const pendingInteractionFileChangeApprovalDecisionSchema = z.enum([
  "accept",
  "accept_for_session",
  "decline",
  "cancel",
]);
export type PendingInteractionFileChangeApprovalDecision = z.infer<
  typeof pendingInteractionFileChangeApprovalDecisionSchema
>;

export function formatPendingInteractionFileChangeApprovalResolutionOutcome(
  decision: PendingInteractionFileChangeApprovalDecision,
): string {
  switch (decision) {
    case "accept":
      return "approved";
    case "accept_for_session":
      return "approved for this session";
    case "decline":
      return "denied";
    case "cancel":
      return "cancelled";
  }
}

export function formatPendingInteractionFileChangeApprovalResolutionMessage(
  decision: PendingInteractionFileChangeApprovalDecision,
): string {
  if (decision === "cancel") {
    return "File-change request cancelled";
  }

  return `File changes ${formatPendingInteractionFileChangeApprovalResolutionOutcome(decision)}`;
}

export const pendingInteractionPermissionGrantScopeSchema = z.enum([
  "turn",
  "session",
]);
export type PendingInteractionPermissionGrantScope = z.infer<
  typeof pendingInteractionPermissionGrantScopeSchema
>;

export interface PendingInteractionPermissionResolutionSummaryArgs {
  permissions: PendingInteractionGrantedPermissionProfile;
  scope: PendingInteractionPermissionGrantScope;
}

export function hasPendingInteractionGrantedPermissions(
  permissions: PendingInteractionGrantedPermissionProfile,
): boolean {
  return (
    permissions.network?.enabled === true ||
    (permissions.fileSystem !== null &&
      (permissions.fileSystem.read.length > 0 || permissions.fileSystem.write.length > 0))
  );
}

export function formatPendingInteractionPermissionResolutionOutcome(
  args: PendingInteractionPermissionResolutionSummaryArgs,
): string {
  if (!hasPendingInteractionGrantedPermissions(args.permissions)) {
    return "denied";
  }

  switch (args.scope) {
    case "turn":
      return "granted for this turn";
    case "session":
      return "granted for this session";
  }
}

export function formatPendingInteractionPermissionResolutionMessage(
  args: PendingInteractionPermissionResolutionSummaryArgs,
): string {
  if (!hasPendingInteractionGrantedPermissions(args.permissions)) {
    return "Permission request denied";
  }

  return `Permissions ${formatPendingInteractionPermissionResolutionOutcome(args)}`;
}

export interface PendingInteractionQuestionOptionInput {
  label: string;
  description: string;
  preview: string | null | undefined;
}

export const pendingInteractionQuestionOptionSchema = z.object({
  label: z.string(),
  description: z.string(),
  preview: z.string().nullable(),
});
export type PendingInteractionQuestionOption = z.infer<
  typeof pendingInteractionQuestionOptionSchema
>;

export function normalizePendingInteractionQuestionOption(
  input: PendingInteractionQuestionOptionInput,
): PendingInteractionQuestionOption {
  return pendingInteractionQuestionOptionSchema.parse({
    label: input.label,
    description: input.description,
    preview: input.preview ?? null,
  });
}

export function toOptionalPendingInteractionQuestionOptionPreview(
  preview: string | null,
): string | undefined {
  return preview ?? undefined;
}

export const pendingInteractionUserInputQuestionSchema = z.object({
  id: z.string(),
  header: z.string(),
  question: z.string(),
  allowsOther: z.boolean(),
  isSecret: z.boolean(),
  multiSelect: z.boolean(),
  options: z.array(pendingInteractionQuestionOptionSchema),
});
export type PendingInteractionUserInputQuestion = z.infer<
  typeof pendingInteractionUserInputQuestionSchema
>;

export const commandApprovalPendingInteractionPayloadSchema = z.object({
  kind: z.literal("command_approval"),
  itemId: z.string().min(1),
  approvalId: z.string().nullable(),
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
  permissions: pendingInteractionRequestedPermissionProfileSchema,
});
export type PermissionRequestPendingInteractionPayload = z.infer<
  typeof permissionRequestPendingInteractionPayloadSchema
>;

export const userInputRequestPendingInteractionPayloadSchema = z.object({
  kind: z.literal("user_input_request"),
  itemId: z.string().min(1),
  questions: z.array(pendingInteractionUserInputQuestionSchema),
});
export type UserInputRequestPendingInteractionPayload = z.infer<
  typeof userInputRequestPendingInteractionPayloadSchema
>;

export const pendingInteractionPayloadSchema = z.discriminatedUnion("kind", [
  commandApprovalPendingInteractionPayloadSchema,
  fileChangeApprovalPendingInteractionPayloadSchema,
  permissionRequestPendingInteractionPayloadSchema,
  userInputRequestPendingInteractionPayloadSchema,
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

export const permissionRequestPendingInteractionResolutionSchema = z.object({
  kind: z.literal("permission_request"),
  permissions: pendingInteractionGrantedPermissionProfileSchema,
  scope: pendingInteractionPermissionGrantScopeSchema,
});
export type PermissionRequestPendingInteractionResolution = z.infer<
  typeof permissionRequestPendingInteractionResolutionSchema
>;

export const userInputRequestPendingInteractionResolutionSchema = z.object({
  kind: z.literal("user_input_request"),
  answers: z.record(z.string(), z.array(z.string())),
});
export type UserInputRequestPendingInteractionResolution = z.infer<
  typeof userInputRequestPendingInteractionResolutionSchema
>;

export const pendingInteractionResolutionSchema = z.discriminatedUnion("kind", [
  commandApprovalPendingInteractionResolutionSchema,
  fileChangeApprovalPendingInteractionResolutionSchema,
  permissionRequestPendingInteractionResolutionSchema,
  userInputRequestPendingInteractionResolutionSchema,
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
  providerRequestMethod: z.string().min(1),
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
  providerRequestMethod: z.string().min(1),
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
