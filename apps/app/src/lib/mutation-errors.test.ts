import { describe, expect, it } from "vitest";
import { HttpError } from "./api";
import { getMutationErrorMessage } from "./mutation-errors";

describe("getMutationErrorMessage", () => {
  it("prefers the server contract message for HttpError instances", () => {
    const error = new HttpError({
      body: {
        code: "invalid_request",
        message: "Environment is not ready",
      },
      code: "invalid_request",
      message: "Environment is not ready",
      status: 409,
    });

    expect(getMutationErrorMessage({
      error,
      fallbackMessage: "Request failed.",
    })).toBe("Environment is not ready");
  });

  it("returns a friendly message for transport failures", () => {
    expect(getMutationErrorMessage({
      error: new TypeError("Failed to fetch"),
      fallbackMessage: "Request failed.",
    })).toBe("Could not reach the server. Check that it is running and try again.");
  });
});
