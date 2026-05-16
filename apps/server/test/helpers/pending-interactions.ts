import type {
  ApprovalPendingInteractionPayload,
  ApprovalPendingInteractionResolution,
  PendingInteractionApprovalDecision,
  PendingInteractionCommandAction,
  PendingInteractionGrantedPermissionProfile,
  PendingInteractionGrantablePermissionProfile,
  UserQuestionPendingInteractionPayload,
  UserQuestionPendingInteractionResolution,
} from "@bb/domain";

type PendingInteractionFileChangeWriteScope = string;

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

type UserQuestionPayloadOptions = {
  allowFreeText?: boolean;
  interactionLabel?: string;
  multiSelect?: boolean;
  prompt?: string;
  questionId?: string;
};

type UserAnswerResolutionOptions = {
  freeText?: string;
  questionId?: string;
  selected?: string[];
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

export const defaultGrantablePermissions: PendingInteractionGrantablePermissionProfile =
  {
    network: null,
    fileSystem: null,
  };

export function createCommandApprovalPayload(
  options: CommandApprovalPayloadOptions = {},
): ApprovalPendingInteractionPayload {
  return {
    kind: "approval",
    subject: {
      kind: "command",
      itemId: options.itemId ?? "item-command-approval",
      command: options.command ?? "git push",
      cwd: options.cwd ?? "/tmp/project",
      actions: options.actions ?? [],
      sessionGrant: options.sessionGrant ?? null,
    },
    reason: options.reason ?? "Needs approval",
    availableDecisions:
      options.availableDecisions ??
      (options.sessionGrant
        ? defaultAvailableDecisions
        : defaultBinaryAvailableDecisions),
  };
}

export function createFileChangeApprovalPayload(
  options: FileChangeApprovalPayloadOptions = {},
): ApprovalPendingInteractionPayload {
  return {
    kind: "approval",
    subject: {
      kind: "file_change",
      itemId: options.itemId ?? "item-file-change-approval",
      writeScope: options.writeScope ?? null,
      sessionGrant: options.sessionGrant ?? null,
    },
    reason: options.reason ?? "Approve file edit",
    availableDecisions:
      options.availableDecisions ??
      (options.sessionGrant
        ? defaultAvailableDecisions
        : defaultBinaryAvailableDecisions),
  };
}

export function createPermissionGrantApprovalPayload(
  options: PermissionGrantApprovalPayloadOptions = {},
): ApprovalPendingInteractionPayload {
  const permissions = options.permissions ?? defaultGrantablePermissions;
  return {
    kind: "approval",
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

export function createUserQuestionPayload(
  options: UserQuestionPayloadOptions = {},
): UserQuestionPendingInteractionPayload {
  return {
    kind: "user_question",
    questions: [
      {
        id: options.questionId ?? "question-1",
        prompt: options.prompt ?? "Which deployment target should I use?",
        shortLabel: options.interactionLabel ?? "Target",
        multiSelect: options.multiSelect ?? false,
        options: [
          { value: "staging", label: "Staging" },
          { value: "production", label: "Production" },
        ],
        allowFreeText: options.allowFreeText ?? true,
      },
    ],
  };
}

export function createUserAnswerResolution(
  options: UserAnswerResolutionOptions = {},
): UserQuestionPendingInteractionResolution {
  return {
    kind: "user_answer",
    answers: {
      [options.questionId ?? "question-1"]: {
        selected: options.selected ?? ["staging"],
        ...(options.freeText ? { freeText: options.freeText } : {}),
      },
    },
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
