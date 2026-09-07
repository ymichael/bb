import type { ProviderErrorCategory } from "@bb/domain";
import type { EventProjectionErrorMessage } from "./event-projection-types.js";

interface TimelineErrorDisplay {
  title: string;
  detail: string | null;
}

const providerErrorCategoryTitles = {
  "active-turn-not-steerable": "Turn is not steerable",
  "bad-request": "Provider rejected request",
  billing: "Provider billing issue",
  "budget-exceeded": "Provider budget exceeded",
  "connection-failed": "Provider connection failed",
  "context-window-exceeded": "Context window exceeded",
  internal: "Provider internal error",
  "max-output-tokens": "Provider output token limit reached",
  "max-turns": "Maximum turns reached",
  overloaded: "Provider overloaded",
  policy: "Provider policy blocked request",
  "rate-limit": "Provider rate limit reached",
  sandbox: "Provider sandbox error",
  "stream-disconnected": "Provider stream disconnected",
  "structured-output-retries": "Structured output retries exhausted",
  "thread-rollback-failed": "Thread rollback failed",
  "too-many-failed-attempts": "Provider failed after too many attempts",
  unauthorized: "Provider authorization failed",
  unknown: "Provider error",
} satisfies Record<ProviderErrorCategory, string>;

const MAX_ERROR_TITLE_LENGTH = 80;

const reconnectProgressPattern = /^Reconnecting\.\.\.\s+\d+\/\d+$/u;

interface ReconnectDisplay {
  progress: string;
  cause: string | null;
}

function reconnectDisplay(
  message: EventProjectionErrorMessage,
): ReconnectDisplay | null {
  if (
    message.reconnectAttempt !== undefined &&
    message.reconnectTotal !== undefined
  ) {
    return {
      progress: `Reconnecting... ${message.reconnectAttempt}/${message.reconnectTotal}`,
      cause: nonEmpty(message.detail),
    };
  }

  if (message.detail === null) {
    return null;
  }
  const [first, ...rest] = message.detail.split("\n");
  if (first === undefined || !reconnectProgressPattern.test(first.trim())) {
    return null;
  }
  return { progress: first.trim(), cause: nonEmpty(rest.join("\n")) };
}

export function buildTimelineErrorDisplay(
  message: EventProjectionErrorMessage,
): TimelineErrorDisplay {
  const reconnect = reconnectDisplay(message);
  if (reconnect) {
    return { title: reconnect.progress, detail: reconnect.cause };
  }

  const { title, detail } = resolveErrorTitleDetail(message);
  if (title.length <= MAX_ERROR_TITLE_LENGTH) {
    return { title, detail };
  }
  return {
    title: genericErrorTitle(message.rawType),
    detail: detail ?? title,
  };
}

function resolveErrorTitleDetail(
  message: EventProjectionErrorMessage,
): TimelineErrorDisplay {
  if (
    message.rawType === "provider/error" &&
    message.providerErrorInfo &&
    message.providerErrorInfo.category !== "unknown"
  ) {
    const title =
      providerErrorCategoryTitles[message.providerErrorInfo.category];
    return { title, detail: detailBeyondTitle(message.detail, title) };
  }

  if (message.rawType === "provider/error") {
    const content = message.detail ?? message.message;
    return { title: content, detail: null };
  }

  return {
    title: message.message,
    detail: detailBeyondTitle(message.detail, message.message),
  };
}

function genericErrorTitle(rawType: string): string {
  return rawType === "provider/error" ? "Provider error" : "System error";
}

function detailBeyondTitle(
  detail: string | null,
  title: string,
): string | null {
  if (detail === null || detail.trim() === title.trim()) {
    return null;
  }
  return detail;
}

function nonEmpty(value: string | null): string | null {
  if (value === null) {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
