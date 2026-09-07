import { ConnectListError } from "@bb/connect-client";
import { toRecord } from "@bb/core-ui";
import { BbHttpError } from "@bb/sdk/browser";

export type AuthErrorKind = "auth-required" | "network" | "http" | "unknown";

interface ResponseLike {
  status: number;
  headers: { get(name: string): string | null };
}

function isResponseLike(value: unknown): value is ResponseLike {
  const record = toRecord(value);
  if (!record || typeof record.status !== "number") return false;
  const headers = toRecord(record.headers);
  return typeof headers?.get === "function";
}

function isAuthStatus(status: number): boolean {
  return status === 401 || status === 403;
}

export function mapAuthError(input: unknown): AuthErrorKind {
  if (input instanceof ConnectListError) {
    return input.code === "unauthorized" ? "auth-required" : "network";
  }
  if (input instanceof BbHttpError) {
    return isAuthStatus(input.status) ? "auth-required" : "http";
  }
  if (isResponseLike(input)) {
    if (isAuthStatus(input.status)) return "auth-required";
    return input.status >= 400 ? "http" : "unknown";
  }
  const record = toRecord(input);
  if (record) {
    if (typeof record.status === "number" && isAuthStatus(record.status)) {
      return "auth-required";
    }
    if (record.name === "AbortError" || record.name === "TimeoutError") {
      return "network";
    }
    if (typeof record.message === "string") {
      const message = record.message.toLowerCase();
      if (
        message.includes("network request failed") ||
        message.includes("failed to fetch") ||
        message.includes("load failed") ||
        message.includes("networkerror") ||
        message.includes("network connection was lost")
      ) {
        return "network";
      }
    }
  }
  return "unknown";
}
