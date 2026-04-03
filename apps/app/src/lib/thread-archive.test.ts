import { describe, expect, it } from "vitest"
import { HttpError } from "./api"
import { isArchiveForceRequiredError } from "./thread-archive"

describe("thread-archive", () => {
  it("recognizes archive confirmation conflicts from the server", () => {
    expect(
      isArchiveForceRequiredError(
        new HttpError({
          status: 409,
          message: "Archiving this thread would clean up a workspace that contains work.",
          code: "archive_confirmation_required",
        }),
      ),
    ).toBe(true)
    expect(
      isArchiveForceRequiredError(
        new HttpError({
          status: 500,
          message: "Internal error",
          code: "internal_error",
        }),
      ),
    ).toBe(false)
  })
})
