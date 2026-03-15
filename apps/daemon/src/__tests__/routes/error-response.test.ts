import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { DomainError, type DomainErrorCode } from "../../domain-errors.js";
import { sendRouteError } from "../../routes/error-response.js";

function createErrorApp(err: unknown): Hono {
  const app = new Hono();
  app.get("/", (c) => sendRouteError(c, err));
  return app;
}

const STATUS_BY_CODE: Record<DomainErrorCode, number> = {
  invalid_request: 400,
  thread_not_found: 404,
  project_not_found: 404,
  thread_archived: 409,
  inactive_session: 409,
  no_active_turn: 409,
  thread_provisioning: 409,
  thread_provisioning_failed: 409,
  unsupported_operation: 422,
  provider_unavailable: 503,
  provider_timeout: 504,
  provider_rpc_error: 502,
};

describe("sendRouteError", () => {
  it("maps each known domain error code to the expected status", async () => {
    for (const [code, expectedStatus] of Object.entries(STATUS_BY_CODE)) {
      const app = createErrorApp(
        new DomainError(code as DomainErrorCode, `${code} message`),
      );
      const response = await app.request("/");
      const body = await response.json();

      expect(response.status).toBe(expectedStatus);
      expect(body.code).toBe(code);
      expect(body.message).toBe(`${code} message`);
    }
  });

  it("maps unknown errors to internal_error", async () => {
    const app = createErrorApp(new Error("boom"));
    const response = await app.request("/");
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.code).toBe("internal_error");
    expect(body.message).toBe("boom");
  });
});
