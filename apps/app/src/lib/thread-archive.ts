import {
  assertNever,
  type SystemEnvironmentInfo,
  type ThreadWorkStatus,
} from "@beanbag/agent-core"
import { HttpError } from "./api"

type ArchiveEnvironmentShape = Pick<SystemEnvironmentInfo, "capabilities">

export function requiresArchiveConfirmation(
  workStatus: ThreadWorkStatus | null | undefined,
  environment: ArchiveEnvironmentShape | null | undefined,
): boolean {
  if (environment?.capabilities.isolated_workspace !== true || !workStatus) {
    return false
  }

  switch (workStatus.state) {
    case "clean":
    case "deleted":
      return false
    case "untracked":
    case "dirty_uncommitted":
    case "committed_unmerged":
    case "dirty_and_committed_unmerged":
      return true
    default:
      return assertNever(workStatus.state)
  }
}

export function isArchiveForceRequiredError(error: unknown): error is HttpError {
  return (
    error instanceof HttpError &&
    error.status === 409 &&
    error.code === "worktree_not_clean"
  )
}
