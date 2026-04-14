import type {
  ApprovalPendingInteractionResolution,
  PendingInteractionApprovalDecision,
  PendingInteractionCommandAction,
  PendingInteractionFileChangeWriteScope,
  PendingInteractionCreate,
  PendingInteractionGrantedPermissionProfile,
  PendingInteractionGrantablePermissionProfile,
} from "@bb/domain";

type ApprovalPayload = PendingInteractionCreate["payload"];

type CommandApprovalPayloadOptions = {
  itemId?: string;
  reason?: string | null;
  command?: string;
  cwd?: string | null;
  actions?: PendingInteractionCommandAction[];
  sessionGrant?: PendingInteractionGrantablePermissionProfile | null;
  availableDecisions?: PendingInteractionApprovalDecision[];
};

type FileChangeApprovalPayloadOptions = {
  itemId?: string;
  reason?: string | null;
  writeScope?: PendingInteractionFileChangeWriteScope | null;
  sessionGrant?: PendingInteractionGrantablePermissionProfile | null;
  availableDecisions?: PendingInteractionApprovalDecision[];
};

type PermissionGrantApprovalPayloadOptions = {
  itemId?: string;
  reason?: string | null;
  toolName?: string | null;
  permissions?: PendingInteractionGrantablePermissionProfile;
  availableDecisions?: PendingInteractionApprovalDecision[];
};

const defaultAvailableDecisions: PendingInteractionApprovalDecision[] = [
  "allow_once",
  "allow_for_session",
  "deny",
];

const defaultBinaryAvailableDecisions: PendingInteractionApprovalDecision[] = [
  "allow_once",
  "deny",
];

export const defaultGrantablePermissions: PendingInteractionGrantablePermissionProfile = {
  network: null,
  fileSystem: null,
};

export function createCommandApprovalPayload(
  options: CommandApprovalPayloadOptions = {},
): ApprovalPayload {
  return {
    subject: {
      kind: "command",
      itemId: options.itemId ?? "item-command-approval",
      command: options.command ?? "git push",
      cwd: options.cwd ?? "/tmp/project",
      actions: options.actions ?? [],
      sessionGrant: options.sessionGrant ?? null,
    },
    reason: options.reason ?? "Needs approval",
    availableDecisions: options.availableDecisions
      ?? (options.sessionGrant ? defaultAvailableDecisions : defaultBinaryAvailableDecisions),
  };
}

export function createFileChangeApprovalPayload(
  options: FileChangeApprovalPayloadOptions = {},
): ApprovalPayload {
  return {
    subject: {
      kind: "file_change",
      itemId: options.itemId ?? "item-file-change-approval",
      writeScope: options.writeScope ?? null,
      sessionGrant: options.sessionGrant ?? null,
    },
    reason: options.reason ?? "Approve file edit",
    availableDecisions: options.availableDecisions
      ?? (options.sessionGrant ? defaultAvailableDecisions : defaultBinaryAvailableDecisions),
  };
}

export function createPermissionGrantApprovalPayload(
  options: PermissionGrantApprovalPayloadOptions = {},
): ApprovalPayload {
  const permissions = options.permissions ?? defaultGrantablePermissions;
  return {
    subject: {
      kind: "permission_grant",
      itemId: options.itemId ?? "item-permission-grant",
      toolName: options.toolName ?? "Bash",
      permissions,
    },
    reason: options.reason ?? "Grant permission",
    availableDecisions: options.availableDecisions ?? defaultAvailableDecisions,
  };
}

export function createAllowOnceResolution(
  grantedPermissions: PendingInteractionGrantedPermissionProfile | null = null,
): ApprovalPendingInteractionResolution {
  return {
    decision: "allow_once",
    grantedPermissions,
  };
}

export function createAllowForSessionResolution(
  grantedPermissions: PendingInteractionGrantedPermissionProfile | null = null,
): ApprovalPendingInteractionResolution {
  return {
    decision: "allow_for_session",
    grantedPermissions,
  };
}

export function createDenyResolution(): ApprovalPendingInteractionResolution {
  return {
    decision: "deny",
  };
}
