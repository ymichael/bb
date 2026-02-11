export type DomainErrorCode =
  | "invalid_request"
  | "thread_not_found"
  | "thread_archived"
  | "thread_provisioning"
  | "thread_provisioning_failed"
  | "project_not_found"
  | "inactive_session"
  | "no_active_turn"
  | "unsupported_operation"
  | "provider_unavailable"
  | "provider_timeout"
  | "provider_rpc_error";

export interface DomainErrorOptions {
  retryable?: boolean;
  details?: unknown;
}

export class DomainError extends Error {
  readonly code: DomainErrorCode;
  readonly retryable: boolean;
  readonly details?: unknown;

  constructor(
    code: DomainErrorCode,
    message: string,
    options?: DomainErrorOptions,
  ) {
    super(message);
    this.name = "DomainError";
    this.code = code;
    this.retryable = options?.retryable ?? false;
    this.details = options?.details;
  }
}

export function isDomainError(err: unknown): err is DomainError {
  return err instanceof DomainError;
}

export function invalidRequestError(
  message: string,
  details?: unknown,
): DomainError {
  return new DomainError("invalid_request", message, { details });
}

export function threadNotFoundError(threadId: string): DomainError {
  return new DomainError("thread_not_found", `Thread ${threadId} not found`);
}

export function threadArchivedError(threadId: string): DomainError {
  return new DomainError("thread_archived", `Thread ${threadId} is archived`);
}

export function threadProvisioningError(threadId: string): DomainError {
  return new DomainError(
    "thread_provisioning",
    `Thread ${threadId} is still provisioning`,
    { retryable: true },
  );
}

export function threadProvisioningFailedError(threadId: string): DomainError {
  return new DomainError(
    "thread_provisioning_failed",
    `Thread ${threadId} provisioning failed; reprovision started`,
    { retryable: true },
  );
}

export function projectNotFoundError(projectId: string): DomainError {
  return new DomainError("project_not_found", `Project ${projectId} not found`);
}

export function inactiveSessionError(message: string): DomainError {
  return new DomainError("inactive_session", message);
}

export function noActiveTurnError(threadId: string): DomainError {
  return new DomainError(
    "no_active_turn",
    `Thread ${threadId} has no active turn to steer`,
  );
}

export function unsupportedOperationError(message: string): DomainError {
  return new DomainError("unsupported_operation", message);
}

export function providerUnavailableError(message: string): DomainError {
  return new DomainError("provider_unavailable", message, {
    retryable: true,
  });
}

export function providerTimeoutError(message: string): DomainError {
  return new DomainError("provider_timeout", message, {
    retryable: true,
  });
}

export function providerRpcError(message: string): DomainError {
  return new DomainError("provider_rpc_error", message);
}
