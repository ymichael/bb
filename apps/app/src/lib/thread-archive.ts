import {
  assertNever,
} from "@bb/core-ui"
import type {
  Environment,
  WorkspaceStatus,
} from "@bb/domain"
import { HttpError } from "./api"

type ArchiveEnvironmentShape = Pick<Environment, "managed">

function isIsolatedArchiveEnvironment(
  environment: ArchiveEnvironmentShape | null | undefined,
): boolean {
  if (!environment) {
    return false
  }
  return environment.managed === true
}

export function requiresArchiveConfirmation(
  workStatus: WorkspaceStatus | null | undefined,
  environment: ArchiveEnvironmentShape | null | undefined,
): boolean {
  if (!isIsolatedArchiveEnvironment(environment) || !workStatus) {
    return false
  }

  switch (workStatus.workingTree.state) {
    case "clean":
    case "deleted":
      return workStatus.mergeBase?.hasCommittedUnmergedChanges === true
    case "untracked":
    case "dirty_uncommitted":
    case "committed_unmerged":
    case "dirty_and_committed_unmerged":
      return true
    default:
      return assertNever(workStatus.workingTree.state)
  }
}

export function isArchiveForceRequiredError(error: unknown): error is HttpError {
  return (
    error instanceof HttpError &&
    error.status === 409 &&
    error.code === "worktree_not_clean"
  )
}
