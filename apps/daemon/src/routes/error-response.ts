import type { Context } from "hono";
import { assertNever } from "@beanbag/agent-core";
import type { DomainErrorCode } from "../domain-errors.js";
import { isDomainError } from "../domain-errors.js";

type ApiErrorCode = DomainErrorCode | "internal_error";

interface ApiErrorBody {
  code: string;
  message: string;
  retryable?: boolean;
  details?: unknown;
}

type ApiErrorStatus = 400 | 404 | 409 | 422 | 500 | 502 | 503 | 504;

function statusFromCode(code: ApiErrorCode): ApiErrorStatus {
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
    case "internal_error":
      return 500;
    default:
      return assertNever(code);
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
  };
}

export function sendApiError(
  c: Context,
  args: {
    status: ApiErrorStatus;
    code: string;
    message: string;
    retryable?: boolean;
    details?: unknown;
  },
): Response {
  return c.json(
    createBody(args.code, args.message, {
      retryable: args.retryable,
      details: args.details,
    }),
    args.status,
  );
}

export function sendRouteError(c: Context, err: unknown): Response {
  if (isDomainError(err)) {
    return sendApiError(c, {
      status: statusFromCode(err.code),
      code: err.code,
      message: err.message,
      retryable: err.retryable,
      details: err.details,
    });
  }

  const message = err instanceof Error ? err.message : "Unknown error";
  return sendApiError(c, {
    status: 500,
    code: "internal_error",
    message,
  });
}
