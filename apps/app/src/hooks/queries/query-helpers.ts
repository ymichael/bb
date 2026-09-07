import { toRecord } from "@bb/core-ui";
import { HttpError } from "@/lib/api";
import { BbHttpError } from "@/lib/sdk";

export const PROMPT_HISTORY_STALE_TIME_MS = 10_000;
const TRANSIENT_READ_RETRY_COUNT = 2;
export const TRANSIENT_READ_RETRY_DELAY_MS = 250;

export interface QueryOptions {
  enabled?: boolean;
}

interface RequireEnabledQueryArgArgs<T> {
  value: T | null | undefined;
  hookName: string;
  argName: string;
}

export function requireEnabledQueryArg<T>({
  value,
  hookName,
  argName,
}: RequireEnabledQueryArgArgs<T>): T {
  if (value == null || value === "") {
    throw new Error(
      `${hookName}: ${argName} is required when query is enabled`,
    );
  }
  return value;
}

export function requireProjectId(
  projectId: string | undefined,
  hookName: string,
): string {
  return requireEnabledQueryArg({
    value: projectId,
    hookName,
    argName: "projectId",
  });
}

export function requireThreadId(id: string, hookName: string): string {
  return requireEnabledQueryArg({ value: id, hookName, argName: "thread id" });
}

function normalizeErrorMessage(message: string): string {
  return message.replace(/\s+/g, " ").trim().toLowerCase();
}

export function isTransientReadError(error: unknown): boolean {
  if (toRecord(error)?.name === "AbortError") {
    return true;
  }
  if (error instanceof HttpError || error instanceof BbHttpError) {
    return false;
  }

  const record = toRecord(error);
  if (!record || typeof record.message !== "string") {
    return false;
  }

  const message = normalizeErrorMessage(record.message);
  return (
    message.includes("failed to fetch") ||
    message.includes("load failed") ||
    message.includes("networkerror")
  );
}

export function shouldRetryTransientReadQuery(
  failureCount: number,
  error: unknown,
): boolean {
  if (failureCount >= TRANSIENT_READ_RETRY_COUNT) {
    return false;
  }

  return isTransientReadError(error);
}
