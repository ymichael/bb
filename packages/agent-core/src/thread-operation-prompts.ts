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
    `You are handling a commit request in ${formatPromptTarget(target)}.`,
    "Review git status and the diff before committing.",
    includeUnstaged
      ? "Stage all relevant tracked and untracked changes before committing."
      : "Commit only currently staged changes and leave unstaged edits untouched.",
    commitMessageHint
      ? `Use this commit message exactly: "${commitMessageHint}".`
      : "If no commit message is provided, create a concise conventional commit message.",
    "Create at most one commit for this request.",
    "Reply with whether a commit was created, the commit SHA if present, and any blockers.",
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
    `You are handling a squash-merge request in ${formatPromptTarget(target)}.`,
    mergeBaseBranch
      ? `Use "${mergeBaseBranch}" as the merge base/target branch.`
      : "Use the default merge-base branch reported by git.",
    commitIfNeeded
      ? includeUnstaged
        ? "If the workspace is dirty, stage relevant changes and create a prep commit before squash merging."
        : "If the workspace is dirty, create a prep commit from currently staged changes before squash merging."
      : "Do not create a prep commit unless explicitly required to complete the merge.",
    commitMessage
      ? `If a prep commit is required, use this commit message: "${commitMessage}".`
      : "If a prep commit is required and no message is provided, generate a concise commit message.",
    squashMessage
      ? `Use this squash-merge message: "${squashMessage}".`
      : "If no squash message is provided, write a concise squash-merge message.",
    "If conflicts occur, resolve them, run relevant checks, and summarize what was resolved.",
    "Reply with whether the squash merge completed and list any blockers.",
  ];
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
