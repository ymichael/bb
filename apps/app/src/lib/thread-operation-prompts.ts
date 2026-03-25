import { assertNever } from "@bb/core-ui";
import type { EnvironmentActionRequest } from "@bb/server-contract";
import { renderTemplate } from "@bb/templates";

type SquashMergeCommitFailureStage = "prep_commit" | "squash_commit";

export function buildSquashMergeConflictFollowUpInstruction(
  request: Extract<EnvironmentActionRequest, { action: "squash_merge" }>,
  options?: {
    conflictFiles?: string[];
  },
): string {
  const conflictFiles = options?.conflictFiles?.filter((file) => file.trim().length > 0) ?? [];
  const mergeBaseBranch = request.options?.mergeBaseBranch?.trim() || "the default branch";
  const conflictFilesText = conflictFiles.length > 0 ? conflictFiles.join(", ") : undefined;

  return renderTemplate("threadOperationSquashMergeConflictFollowUp", {
    mergeBaseBranch,
    conflictFiles: conflictFilesText,
  });
}

export function buildSquashMergeCommitFailureFollowUpInstruction(
  request: Extract<EnvironmentActionRequest, { action: "squash_merge" }>,
  options: {
    stage: SquashMergeCommitFailureStage;
    errorMessage?: string;
  },
): string {
  const mergeBaseBranch = request.options?.mergeBaseBranch?.trim() || "the default branch";
  const errorMessage = options.errorMessage?.trim() || undefined;

  switch (options.stage) {
    case "prep_commit":
      return renderTemplate("threadOperationSquashMergeCommitFailureFollowUp", {
        prepCommitMergeBaseBranch: mergeBaseBranch,
        errorMessage,
      });
    case "squash_commit":
      return renderTemplate("threadOperationSquashMergeCommitFailureFollowUp", {
        squashCommitMergeBaseBranch: mergeBaseBranch,
        errorMessage,
      });
    default:
      return assertNever(options.stage);
  }
}

export function buildCommitFailureFollowUpInstruction(
  request: Extract<EnvironmentActionRequest, { action: "commit" }>,
  options?: {
    errorMessage?: string;
  },
): string {
  const exactCommitMessage = request.options?.message?.trim() || undefined;
  const errorMessage = options?.errorMessage?.trim() || undefined;

  return renderTemplate("threadOperationCommitFailureFollowUp", {
    exactCommitMessage,
    errorMessage,
  });
}
