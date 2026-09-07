import { extractErrorMessage, toRecord } from "@bb/core-ui";
import { BbHttpError } from "@bb/sdk/browser";
import { isTransientReadError } from "./query-client";

const HTTP_STATUS_PREFIX_PATTERN = /^HTTP \d{3}:\s*/u;
const TRAILING_PERIOD_PATTERN = /\.$/u;
export const NETWORK_TRANSPORT_ERROR_MESSAGE =
  "Could not reach the server. Check that it is running and try again.";
const GENERIC_REQUEST_FAILED_MESSAGE = "Request failed";

export interface MutationErrorMeta {
  errorMessage?: string;
  showErrorToast?: boolean;
}

function normalizeMessage(message: string): string {
  return message.replace(/\s+/g, " ").trim();
}

function stripHttpStatusPrefix(message: string): string {
  return message.replace(HTTP_STATUS_PREFIX_PATTERN, "");
}

function isAbortLikeError(error: unknown): boolean {
  return toRecord(error)?.name === "AbortError";
}

function getMutationErrorMeta(
  value: Readonly<Record<string, unknown>> | undefined,
): MutationErrorMeta {
  if (!value) return {};
  const errorMessage =
    typeof value.errorMessage === "string"
      ? normalizeMessage(value.errorMessage)
      : undefined;
  const showErrorToast =
    typeof value.showErrorToast === "boolean"
      ? value.showErrorToast
      : undefined;
  return {
    ...(errorMessage ? { errorMessage } : {}),
    ...(showErrorToast === undefined ? {} : { showErrorToast }),
  };
}

function getHttpErrorMessage(error: BbHttpError): string | null {
  const bodyMessage = extractErrorMessage(error.body);
  if (bodyMessage) return normalizeMessage(bodyMessage);
  const stripped = stripHttpStatusPrefix(normalizeMessage(error.message));
  return stripped.length > 0 ? stripped : null;
}

export function getMutationErrorMessage({
  error,
  fallbackMessage,
}: {
  error: unknown;
  fallbackMessage: string;
}): string {
  if (error instanceof BbHttpError) {
    return getHttpErrorMessage(error) ?? fallbackMessage;
  }
  if (!isAbortLikeError(error) && isTransientReadError(error)) {
    return NETWORK_TRANSPORT_ERROR_MESSAGE;
  }
  const extracted = extractErrorMessage(error);
  if (!extracted) return fallbackMessage;
  const normalized = stripHttpStatusPrefix(normalizeMessage(extracted));
  return normalized.length > 0 ? normalized : fallbackMessage;
}

export interface MutationErrorToast {
  title: string;
  description: string | null;
}

export function describeMutationErrorToast(
  error: unknown,
  meta: Readonly<Record<string, unknown>> | undefined,
): MutationErrorToast | null {
  const parsed = getMutationErrorMeta(meta);
  if (parsed.showErrorToast === false) return null;
  if (isAbortLikeError(error)) return null;
  const message = getMutationErrorMessage({
    error,
    fallbackMessage: parsed.errorMessage ?? GENERIC_REQUEST_FAILED_MESSAGE,
  }).replace(TRAILING_PERIOD_PATTERN, "");
  if (message === GENERIC_REQUEST_FAILED_MESSAGE) {
    return {
      title: GENERIC_REQUEST_FAILED_MESSAGE,
      description: "Please try again",
    };
  }
  if (parsed.errorMessage) {
    const headline = parsed.errorMessage.replace(TRAILING_PERIOD_PATTERN, "");
    return headline === message
      ? { title: headline, description: null }
      : { title: headline, description: message };
  }
  return { title: message, description: null };
}
