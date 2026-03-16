import { assertNever } from "./assert-never.js";
import type { ThreadOperationRequest } from "./api-types.js";
import { renderTemplate } from "@bb/templates";

export type ThreadOperationPromptTarget = "thread" | "project_main";
export type SquashMergeCommitFailureStage = "prep_commit" | "squash_commit";

function formatPromptTarget(target: ThreadOperationPromptTarget): string {
  switch (target) {
    case "thread":
      return "this thread workspace";
    case "project_main":
      return "the project primary checkout";
    default:
      return assertNever(target);
  }
}

function buildCommitInstruction(
  request: Extract<ThreadOperationRequest, { operation: "commit" }>,
  target: ThreadOperationPromptTarget,
): string {
  const options = request.options;
  const includeUnstaged = options?.includeUnstaged !== false;
  const commitMessageHint = options?.message?.trim();

  return renderTemplate("threadOperationCommit", {
    targetDescription: formatPromptTarget(target),
    stageInstruction: includeUnstaged
      ? "Please stage relevant tracked and untracked changes before committing."
      : "Please commit only currently staged changes and leave unstaged edits untouched.",
    commitMessageInstruction: commitMessageHint
      ? `Please use this commit message exactly: "${commitMessageHint}".`
      : "If no commit message is provided, please create a concise conventional commit message.",
  });
}

function buildSquashMergeInstruction(
  request: Extract<ThreadOperationRequest, { operation: "squash_merge" }>,
  target: ThreadOperationPromptTarget,
): string {
  const options = request.options;
  const mergeBaseBranch = options?.mergeBaseBranch?.trim();
  const commitMessage = options?.commitMessage?.trim();
  const squashMessage = options?.squashMessage?.trim();
  const includeUnstaged = options?.includeUnstaged !== false;
  const commitIfNeeded = options?.commitIfNeeded === true;

  return renderTemplate("threadOperationSquashMerge", {
    targetDescription: formatPromptTarget(target),
    mergeBaseInstruction: mergeBaseBranch
      ? `Please use "${mergeBaseBranch}" as the merge base/target branch.`
      : "Please use the default merge-base branch reported by git.",
    prepCommitInstruction: commitIfNeeded
      ? includeUnstaged
        ? "If the workspace is dirty, please stage relevant changes and create a prep commit before squash merging."
        : "If the workspace is dirty, please create a prep commit from currently staged changes before squash merging."
      : "Please do not create a prep commit unless explicitly required to complete the merge.",
    commitMessageInstruction: commitMessage
      ? `If a prep commit is required, please use this commit message: "${commitMessage}".`
      : "If a prep commit is required and no message is provided, please generate a concise commit message.",
    squashMessageInstruction: squashMessage
      ? `Please use this squash-merge message: "${squashMessage}".`
      : "If no squash message is provided, please write a concise squash-merge message.",
    conflictInstruction:
      "If conflicts occur, please resolve them, run relevant checks, and summarize what was resolved.",
  });
}

export function buildSquashMergeConflictFollowUpInstruction(
  request: Extract<ThreadOperationRequest, { operation: "squash_merge" }>,
  options?: {
    target?: ThreadOperationPromptTarget;
    conflictFiles?: string[];
  },
): string {
  const conflictFiles = options?.conflictFiles?.filter((file) => file.trim().length > 0) ?? [];
  const mergeBaseBranch = request.options?.mergeBaseBranch?.trim() || "the default branch";
  return renderTemplate("threadOperationSquashMergeConflictFollowUp", {
    mergeBaseBranch,
    ...(conflictFiles.length > 0 ? { conflictFiles: conflictFiles.join(", ") } : {}),
  });
}

export function buildSquashMergeCommitFailureFollowUpInstruction(
  request: Extract<ThreadOperationRequest, { operation: "squash_merge" }>,
  options: {
    stage: SquashMergeCommitFailureStage;
    errorMessage?: string;
  },
): string {
  const mergeBaseBranch = request.options?.mergeBaseBranch?.trim() || "the default branch";
  const steps: string[] = [];
  switch (options.stage) {
    case "prep_commit":
      steps.push(
        `Squash merge to ${mergeBaseBranch} could not create the prep commit. Please inspect the workspace, fix the commit blocker, create the needed prep commit, and retry the squash merge so the changes land on ${mergeBaseBranch}.`,
      );
      break;
    case "squash_commit":
      steps.push(
        `Squash merge to ${mergeBaseBranch} applied changes but failed while creating the squash commit. Please inspect the merge result, fix the commit blocker, and retry the squash merge so the changes land on ${mergeBaseBranch}.`,
      );
      break;
    default:
      assertNever(options.stage);
  }
  return renderTemplate("threadOperationSquashMergeCommitFailureFollowUp", {
    failureInstruction: steps.join("\n"),
    ...(options.errorMessage?.trim() ? { errorMessage: options.errorMessage.trim() } : {}),
  });
}

export function buildCommitFailureFollowUpInstruction(
  request: Extract<ThreadOperationRequest, { operation: "commit" }>,
  options?: {
    target?: ThreadOperationPromptTarget;
    errorMessage?: string;
  },
): string {
  const exactCommitMessage = request.options?.message?.trim();
  return renderTemplate("threadOperationCommitFailureFollowUp", {
    targetDescription: formatPromptTarget(options?.target ?? "thread"),
    ...(exactCommitMessage
      ? {
          exactCommitMessageInstruction: `Use this commit message exactly: "${exactCommitMessage}".`,
        }
      : {}),
    ...(options?.errorMessage?.trim() ? { errorMessage: options.errorMessage.trim() } : {}),
  });
}

export function buildThreadOperationInstruction(
  request: ThreadOperationRequest,
  options?: { target?: ThreadOperationPromptTarget },
): string {
  const target = options?.target ?? "thread";
  switch (request.operation) {
    case "commit":
      return buildCommitInstruction(request, target);
    case "squash_merge":
      return buildSquashMergeInstruction(request, target);
    default:
      return assertNever(request);
  }
}
