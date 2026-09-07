import { extractErrorMessage, toRecord } from "@bb/core-ui";
import { BbHttpError } from "@bb/sdk/browser";
import { appToast } from "@/components/ui/app-toast";
import { HttpError } from "./api";
import {
  describeLifecycleError,
  formatLifecycleErrorDescription,
  type LifecycleErrorOperation,
} from "./lifecycle-errors";

const HTTP_STATUS_PREFIX_PATTERN = /^HTTP \d{3}:\s*/u;
const NETWORK_TRANSPORT_ERROR_MESSAGE =
  "Could not reach the server. Check that it is running and try again.";
const GENERIC_REQUEST_FAILED_MESSAGE = "Request failed";
const TRAILING_PERIOD_PATTERN = /\.$/u;

interface MutationErrorMessageOptions {
  error: unknown;
  fallbackMessage: string;
  lifecycleOperation?: LifecycleErrorOperation | undefined;
}

interface MutationErrorMeta {
  errorMessage?: string;
  lifecycleOperation?: LifecycleErrorOperation;
  showErrorToast?: boolean;
}

type MutationErrorMetaInput = Readonly<Record<string, unknown>> | undefined;

function normalizeMessage(message: string): string {
  return message.replace(/\s+/g, " ").trim();
}

function stripHttpStatusPrefix(message: string): string {
  return message.replace(HTTP_STATUS_PREFIX_PATTERN, "");
}

function isAbortLikeError(error: unknown): boolean {
  return toRecord(error)?.name === "AbortError";
}

function isNetworkTransportError(error: unknown): boolean {
  if (
    error instanceof HttpError ||
    error instanceof BbHttpError ||
    isAbortLikeError(error)
  ) {
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

function toLifecycleErrorOperation(
  value: unknown,
): LifecycleErrorOperation | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  switch (value) {
    case "archive_thread":
    case "commit":
    case "create_thread":
    case "edit_message":
    case "load_diff":
    case "load_git_status":
    case "load_thread_storage":
    case "open_terminal":
    case "queue_message":
    case "reorder_queued_message":
    case "resolve_interaction":
    case "send_message":
    case "send_queued_message":
    case "set_queued_message_group_boundary":
    case "stop_thread":
    case "update_queued_message":
    case "update_merge_base":
      return value;
    default:
      return undefined;
  }
}

function getHttpErrorMessage(error: HttpError | BbHttpError): string | null {
  const bodyMessage = extractErrorMessage(error.body);
  if (bodyMessage) {
    return normalizeMessage(bodyMessage);
  }

  const strippedMessage = stripHttpStatusPrefix(
    normalizeMessage(error.message),
  );
  return strippedMessage.length > 0 ? strippedMessage : null;
}

export function getMutationErrorMeta(
  value: MutationErrorMetaInput,
): MutationErrorMeta {
  if (!value) {
    return {};
  }

  const errorMessage =
    typeof value.errorMessage === "string"
      ? normalizeMessage(value.errorMessage)
      : undefined;
  const showErrorToast =
    typeof value.showErrorToast === "boolean"
      ? value.showErrorToast
      : undefined;
  const lifecycleOperation = toLifecycleErrorOperation(
    value.lifecycleOperation,
  );

  return {
    ...(errorMessage ? { errorMessage } : {}),
    ...(lifecycleOperation ? { lifecycleOperation } : {}),
    ...(showErrorToast === undefined ? {} : { showErrorToast }),
  };
}

export function getMutationErrorMessage({
  error,
  fallbackMessage,
  lifecycleOperation,
}: MutationErrorMessageOptions): string {
  const lifecycleErrorDescription = describeLifecycleError({
    error,
    operation: lifecycleOperation,
  });
  if (lifecycleErrorDescription) {
    return formatLifecycleErrorDescription(lifecycleErrorDescription);
  }

  if (error instanceof HttpError || error instanceof BbHttpError) {
    return getHttpErrorMessage(error) ?? fallbackMessage;
  }

  if (isNetworkTransportError(error)) {
    return NETWORK_TRANSPORT_ERROR_MESSAGE;
  }

  const extractedMessage = extractErrorMessage(error);
  if (!extractedMessage) {
    return fallbackMessage;
  }

  const normalizedMessage = stripHttpStatusPrefix(
    normalizeMessage(extractedMessage),
  );
  return normalizedMessage.length > 0 ? normalizedMessage : fallbackMessage;
}

export function shouldShowMutationErrorToast(error: unknown): boolean {
  return !isAbortLikeError(error);
}

export function showMutationErrorToast({
  error,
  fallbackMessage,
  lifecycleOperation,
}: MutationErrorMessageOptions): void {
  if (!shouldShowMutationErrorToast(error)) {
    return;
  }

  const message = getMutationErrorMessage({
    error,
    fallbackMessage,
    lifecycleOperation,
  }).replace(TRAILING_PERIOD_PATTERN, "");
  if (message === GENERIC_REQUEST_FAILED_MESSAGE) {
    appToast.error("Request failed", {
      description: "Please try again",
    });
    return;
  }

  appToast.error(message);
}
