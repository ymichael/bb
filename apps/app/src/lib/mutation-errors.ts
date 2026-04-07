import {
  extractErrorMessage,
  toRecord,
} from "@bb/core-ui";
import { toast } from "sonner";
import { HttpError } from "./api";

const HTTP_STATUS_PREFIX_PATTERN = /^HTTP \d{3}:\s*/u;
const NETWORK_TRANSPORT_ERROR_MESSAGE =
  "Could not reach the server. Check that it is running and try again.";

export interface MutationErrorMessageOptions {
  error: unknown;
  fallbackMessage: string;
}

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
  if (error instanceof DOMException && error.name === "AbortError") {
    return true;
  }

  const record = toRecord(error);
  return record?.name === "AbortError";
}

function isNetworkTransportError(error: unknown): boolean {
  if (error instanceof HttpError || isAbortLikeError(error)) {
    return false;
  }

  const record = toRecord(error);
  if (!record || typeof record.message !== "string") {
    return false;
  }

  const normalizedMessage = normalizeMessage(record.message).toLowerCase();
  return (
    normalizedMessage.includes("failed to fetch") ||
    normalizedMessage.includes("load failed") ||
    normalizedMessage.includes("networkerror")
  );
}

function getHttpErrorMessage(error: HttpError): string | null {
  const bodyMessage = extractErrorMessage(error.body);
  if (bodyMessage) {
    return normalizeMessage(bodyMessage);
  }

  const strippedMessage = stripHttpStatusPrefix(normalizeMessage(error.message));
  return strippedMessage.length > 0 ? strippedMessage : null;
}

export function getMutationErrorMeta(value: unknown): MutationErrorMeta {
  const record = toRecord(value);
  if (!record) {
    return {};
  }

  const errorMessage =
    typeof record.errorMessage === "string"
      ? normalizeMessage(record.errorMessage)
      : undefined;
  const showErrorToast =
    typeof record.showErrorToast === "boolean"
      ? record.showErrorToast
      : undefined;

  return {
    ...(errorMessage ? { errorMessage } : {}),
    ...(showErrorToast === undefined ? {} : { showErrorToast }),
  };
}

export function getMutationErrorMessage({
  error,
  fallbackMessage,
}: MutationErrorMessageOptions): string {
  if (error instanceof HttpError) {
    return getHttpErrorMessage(error) ?? fallbackMessage;
  }

  if (isNetworkTransportError(error)) {
    return NETWORK_TRANSPORT_ERROR_MESSAGE;
  }

  const extractedMessage = extractErrorMessage(error);
  if (!extractedMessage) {
    return fallbackMessage;
  }

  const normalizedMessage = stripHttpStatusPrefix(normalizeMessage(extractedMessage));
  return normalizedMessage.length > 0 ? normalizedMessage : fallbackMessage;
}

export function shouldShowMutationErrorToast(error: unknown): boolean {
  return !isAbortLikeError(error);
}

export function showMutationErrorToast({
  error,
  fallbackMessage,
}: MutationErrorMessageOptions): void {
  if (!shouldShowMutationErrorToast(error)) {
    return;
  }

  toast.error(
    getMutationErrorMessage({
      error,
      fallbackMessage,
    }),
  );
}
