import { assertNever } from "./assert-never.js";
import type { ThreadOperationRequest } from "./api-types.js";

export type ThreadOperationPromptTarget = "thread" | "project_main";

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

  const steps = [
    `Please commit the changes in ${formatPromptTarget(target)}.`,
    "Please review git status and the diff before committing.",
    includeUnstaged
      ? "Please stage relevant tracked and untracked changes before committing."
      : "Please commit only currently staged changes and leave unstaged edits untouched.",
    commitMessageHint
      ? `Please use this commit message exactly: "${commitMessageHint}".`
      : "If no commit message is provided, please create a concise conventional commit message.",
    "Please create at most one commit.",
    "Please reply with whether a commit was created, the commit SHA if present, and any blockers.",
  ];
  return steps.join("\n");
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

  const steps = [
    `Please squash-merge the changes in ${formatPromptTarget(target)}.`,
    mergeBaseBranch
      ? `Please use "${mergeBaseBranch}" as the merge base/target branch.`
      : "Please use the default merge-base branch reported by git.",
    commitIfNeeded
      ? includeUnstaged
        ? "If the workspace is dirty, please stage relevant changes and create a prep commit before squash merging."
        : "If the workspace is dirty, please create a prep commit from currently staged changes before squash merging."
      : "Please do not create a prep commit unless explicitly required to complete the merge.",
    commitMessage
      ? `If a prep commit is required, please use this commit message: "${commitMessage}".`
      : "If a prep commit is required and no message is provided, please generate a concise commit message.",
    squashMessage
      ? `Please use this squash-merge message: "${squashMessage}".`
      : "If no squash message is provided, please write a concise squash-merge message.",
    "If conflicts occur, please resolve them, run relevant checks, and summarize what was resolved.",
    "Please reply with whether the squash merge completed and list any blockers.",
  ];
  return steps.join("\n");
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
  const steps = [
    `Squash merge to ${mergeBaseBranch} failed with conflicts. Please resolve them and try the squash merge again.`,
  ];
  if (conflictFiles.length > 0) {
    steps.push(`Conflicted files: ${conflictFiles.join(", ")}.`);
  }
  steps.push("Please reply with what you resolved, whether the retry succeeded, and any blockers.");
  return steps.join("\n");
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
