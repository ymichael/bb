import { HTTPException } from "hono/http-exception";

export interface ApiErrorBody {
  code: string;
  message: string;
  retryable?: boolean;
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
    this.body = retryable === undefined
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

export function errorToResponse(error: unknown): Response {
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
  return new Response(
    JSON.stringify({
      code: "internal_error",
      message: error instanceof Error ? error.message : "Internal server error",
    }),
    {
      status: 500,
      headers: {
        "content-type": "application/json",
      },
    },
  );
}
