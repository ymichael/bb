import { HttpError } from "./api"

export function isArchiveForceRequiredError(error: unknown): error is HttpError {
  return (
    error instanceof HttpError &&
    error.status === 409 &&
    error.code === "archive_confirmation_required"
  )
}
