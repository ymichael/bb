import { ApiError } from "../../errors.js";

const inFlightByThreadId = new Map<string, number>();

export class ThreadContextClearInProgressError extends ApiError {
  constructor() {
    super(409, "invalid_request", "Thread context is being cleared");
  }
}

async function withThreadContextMutationGuard<T>(
  threadId: string,
  mode: "clear" | "send",
  work: () => Promise<T>,
): Promise<T> {
  const inFlight = inFlightByThreadId.get(threadId) ?? 0;
  if (inFlight !== 0 && (mode === "clear" || inFlight < 0)) {
    if (mode === "send") throw new ThreadContextClearInProgressError();
    throw new ApiError(
      409,
      "invalid_request",
      "Thread is processing another request",
    );
  }
  inFlightByThreadId.set(threadId, mode === "clear" ? -1 : inFlight + 1);
  try {
    return await work();
  } finally {
    const remaining =
      mode === "clear" ? 0 : (inFlightByThreadId.get(threadId) ?? 1) - 1;
    if (remaining === 0) inFlightByThreadId.delete(threadId);
    else inFlightByThreadId.set(threadId, remaining);
  }
}

export async function withThreadSendGuard<T>(
  threadId: string,
  work: () => Promise<T>,
): Promise<T> {
  return withThreadContextMutationGuard(threadId, "send", work);
}

export async function withThreadContextClearGuard<T>(
  threadId: string,
  work: () => Promise<T>,
): Promise<T> {
  return withThreadContextMutationGuard(threadId, "clear", work);
}
