import type { Context } from "hono";
import { isDomainError } from "../domain-errors.js";

interface ApiErrorBody {
  code: string;
  message: string;
  retryable?: boolean;
  details?: unknown;
  // Backward-compatible alias for existing clients/tests.
  error: string;
}

type ApiErrorStatus = 400 | 404 | 409 | 422 | 500 | 502 | 503 | 504;

function statusFromCode(code: string): ApiErrorStatus {
  switch (code) {
    case "invalid_request":
      return 400;
    case "thread_not_found":
    case "project_not_found":
      return 404;
    case "thread_archived":
    case "inactive_session":
    case "no_active_turn":
    case "thread_provisioning":
    case "thread_provisioning_failed":
      return 409;
    case "unsupported_operation":
      return 422;
    case "provider_unavailable":
      return 503;
    case "provider_timeout":
      return 504;
    case "provider_rpc_error":
      return 502;
    default:
      return 500;
  }
}

function createBody(
  code: string,
  message: string,
  opts?: { retryable?: boolean; details?: unknown },
): ApiErrorBody {
  return {
    code,
    message,
    ...(opts?.retryable ? { retryable: true } : {}),
    ...(opts?.details !== undefined ? { details: opts.details } : {}),
    error: message,
  };
}

export function sendRouteError(c: Context, err: unknown): Response {
  if (isDomainError(err)) {
    return c.json(
      createBody(err.code, err.message, {
        retryable: err.retryable,
        details: err.details,
      }),
      statusFromCode(err.code),
    );
  }

  const message = err instanceof Error ? err.message : "Unknown error";
  return c.json(createBody("internal_error", message), 500);
}
