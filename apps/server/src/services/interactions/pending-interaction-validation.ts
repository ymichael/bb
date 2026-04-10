import {
  formatPendingInteractionCommandApprovalDecision,
} from "@bb/core-ui";
import {
  type PendingInteraction,
  type PendingInteractionCommandApprovalDecision,
  type PendingInteractionFileChangeApprovalDecision,
  type PendingInteractionResolution,
} from "@bb/domain";
import { ApiError } from "../../errors.js";

function commandApprovalDecisionEquals(
  left: PendingInteractionCommandApprovalDecision,
  right: PendingInteractionCommandApprovalDecision,
): boolean {
  if (typeof left === "string" || typeof right === "string") {
    return left === right;
  }

  if (left.kind !== right.kind) {
    return false;
  }

  if (
    left.kind === "accept_with_exec_policy_amendment"
    && right.kind === "accept_with_exec_policy_amendment"
  ) {
    return (
      left.execPolicyAmendment.length === right.execPolicyAmendment.length
      && left.execPolicyAmendment.every(
        (entry, index) => entry === right.execPolicyAmendment[index],
      )
    );
  }

  if (
    left.kind === "apply_network_policy_amendment"
    && right.kind === "apply_network_policy_amendment"
  ) {
    return (
      left.networkPolicyAmendment.host === right.networkPolicyAmendment.host
      && left.networkPolicyAmendment.action === right.networkPolicyAmendment.action
    );
  }

  return false;
}

function validateCommandApprovalResolution(
  interaction: PendingInteraction,
  resolution: PendingInteractionResolution,
): void {
  if (
    interaction.payload.kind !== "command_approval"
    || resolution.kind !== "command_approval"
  ) {
    return;
  }

  if (
    interaction.payload.availableDecisions.some((decision) =>
      commandApprovalDecisionEquals(decision, resolution.decision),
    )
  ) {
    return;
  }

  throw new ApiError(
    400,
    "invalid_request",
    `Command approval decision '${formatPendingInteractionCommandApprovalDecision(resolution.decision)}' is not available for interaction ${interaction.id}`,
  );
}

function hasEmptyAnswer(answers: string[]): boolean {
  return answers.some((answer) => answer.trim().length === 0);
}

function validateUserInputResolution(
  interaction: PendingInteraction,
  resolution: PendingInteractionResolution,
): void {
  if (
    interaction.payload.kind !== "user_input_request"
    || resolution.kind !== "user_input_request"
  ) {
    return;
  }

  const questions = new Map(
    interaction.payload.questions.map((question) => [question.id, question]),
  );
  const unknownQuestionIds = Object.keys(resolution.answers).filter(
    (questionId) => !questions.has(questionId),
  );
  if (unknownQuestionIds.length > 0) {
    throw new ApiError(
      400,
      "invalid_request",
      `Unknown question ids: ${unknownQuestionIds.join(", ")}`,
    );
  }

  const missingQuestionIds = interaction.payload.questions
    .map((question) => question.id)
    .filter((questionId) => !(questionId in resolution.answers));
  if (missingQuestionIds.length > 0) {
    throw new ApiError(
      400,
      "invalid_request",
      `Missing answers for question ids: ${missingQuestionIds.join(", ")}`,
    );
  }

  for (const [questionId, answers] of Object.entries(resolution.answers)) {
    const question = questions.get(questionId);
    if (!question) {
      continue;
    }
    if (answers.length === 0) {
      throw new ApiError(
        400,
        "invalid_request",
        `Question '${questionId}' requires at least one answer`,
      );
    }
    if (hasEmptyAnswer(answers)) {
      throw new ApiError(
        400,
        "invalid_request",
        `Question '${questionId}' cannot include empty answers`,
      );
    }
    if (!question.multiSelect && answers.length > 1) {
      throw new ApiError(
        400,
        "invalid_request",
        `Question '${questionId}' accepts only one answer`,
      );
    }
  }
}

function validateFileChangeApprovalResolution(
  interaction: PendingInteraction,
  resolution: PendingInteractionResolution,
): void {
  if (
    interaction.payload.kind !== "file_change_approval"
    || resolution.kind !== "file_change_approval"
  ) {
    return;
  }

  const allowedDecisions = new Set<PendingInteractionFileChangeApprovalDecision>([
    "accept",
    "accept_for_session",
    "decline",
    "cancel",
  ]);
  if (allowedDecisions.has(resolution.decision)) {
    return;
  }

  throw new ApiError(
    400,
    "invalid_request",
    `File-change approval decision '${resolution.decision}' is invalid`,
  );
}

function validatePermissionRequestResolution(
  interaction: PendingInteraction,
  resolution: PendingInteractionResolution,
): void {
  if (
    interaction.payload.kind !== "permission_request"
    || resolution.kind !== "permission_request"
  ) {
    return;
  }

  if (resolution.permissions.network !== null) {
    if (
      interaction.payload.permissions.network?.enabled !== true
      || resolution.permissions.network.enabled !== true
    ) {
      throw new ApiError(
        400,
        "invalid_request",
        "Granted network permissions must be a subset of the requested permissions",
      );
    }
  }

  if (resolution.permissions.fileSystem !== null) {
    const requestedFileSystem = interaction.payload.permissions.fileSystem;
    if (requestedFileSystem === null) {
      throw new ApiError(
        400,
        "invalid_request",
        "Granted file-system permissions must be a subset of the requested permissions",
      );
    }

    const unknownReadPaths = resolution.permissions.fileSystem.read.filter(
      (path) => !requestedFileSystem.read.includes(path),
    );
    const unknownWritePaths = resolution.permissions.fileSystem.write.filter(
      (path) => !requestedFileSystem.write.includes(path),
    );
    if (unknownReadPaths.length > 0 || unknownWritePaths.length > 0) {
      throw new ApiError(
        400,
        "invalid_request",
        "Granted file-system permissions must be a subset of the requested permissions",
      );
    }
  }
}

export function validatePendingInteractionResolution(
  interaction: PendingInteraction,
  resolution: PendingInteractionResolution,
): void {
  if (interaction.payload.kind !== resolution.kind) {
    throw new ApiError(
      400,
      "invalid_request",
      "Pending interaction resolution kind does not match the interaction payload",
    );
  }

  validateCommandApprovalResolution(interaction, resolution);
  validateFileChangeApprovalResolution(interaction, resolution);
  validatePermissionRequestResolution(interaction, resolution);
  validateUserInputResolution(interaction, resolution);
}
