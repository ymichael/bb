import { HTTPException } from "hono/http-exception";
import type { ThreadEventScopeKind, ThreadEventType } from "@bb/domain";
import type { ServerLogger } from "./types.js";

export interface ApiErrorBody {
  code: string;
  message: string;
  retryable?: boolean;
}

export interface TurnStartGuardFailureDetails {
  eventType: ThreadEventType;
  scopeKind: ThreadEventScopeKind;
  threadId: string;
  turnId: string;
}

export class ApiError extends HTTPException {
  readonly body: ApiErrorBody;

  constructor(
    status: ConstructorParameters<typeof HTTPException>[0],
    code: string,
    message: string,
    retryable?: boolean,
  ) {
    super(status, { message });
    this.body =
      retryable === undefined
        ? { code, message }
        : { code, message, retryable };
  }

  toResponse(): Response {
    return new Response(JSON.stringify(this.body), {
      status: this.status,
      headers: {
        "content-type": "application/json",
      },
    });
  }
}

export class TurnStartGuardError extends ApiError {
  readonly details: TurnStartGuardFailureDetails;

  constructor(details: TurnStartGuardFailureDetails) {
    super(
      409,
      "invalid_request",
      `Cannot append ${details.eventType} for turn ${details.turnId} before turn/started is stored`,
    );
    this.name = "TurnStartGuardError";
    this.details = details;
  }
}

export function errorToResponse(
  error: unknown,
  logger: ServerLogger,
): Response {
  if (error instanceof TurnStartGuardError) {
    logger.warn(
      { err: error, ...error.details },
      "Rejected turn-scoped server event before turn/started",
    );
    return error.toResponse();
  }
  if (error instanceof ApiError) {
    return error.toResponse();
  }
  if (error instanceof HTTPException) {
    return new Response(
      JSON.stringify({
        code: "internal_error",
        message: error.message,
      }),
      {
        status: error.status,
        headers: {
          "content-type": "application/json",
        },
      },
    );
  }
  logger.error({ err: error }, "Unhandled server error");
  return new Response(
    JSON.stringify({
      code: "internal_error",
      message: "Internal server error",
    }),
    {
      status: 500,
      headers: {
        "content-type": "application/json",
      },
    },
  );
}
