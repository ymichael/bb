import type {
  JsonObject,
  JsonValue,
  ThreadEvent,
  ThreadTimelineModelFallback,
} from "@bb/domain";
import type { ThreadEventWithMeta } from "./group-event-projection-turns.js";

interface ProviderModelFallbackData {
  originalModel: string;
  fallbackModel: string;
  reason: "refusal" | "provider";
  message: string;
}

function jsonObject(value: JsonValue | undefined): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value
    : null;
}

function nonEmptyString(value: JsonValue | undefined): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function getProviderModelFallbackData(
  event: ThreadEvent,
): ProviderModelFallbackData | null {
  if (event.type === "provider/modelFallback") {
    return {
      originalModel: event.originalModel,
      fallbackModel: event.fallbackModel,
      reason: event.reason,
      message: event.message,
    };
  }
  if (
    event.type !== "provider/unhandled" ||
    event.providerId !== "claude-code" ||
    event.rawEvent.method !== "sdk/message"
  ) {
    return null;
  }

  const params = jsonObject(event.rawEvent.params);
  const rawMessage = jsonObject(params?.message);
  if (rawMessage === null) {
    return null;
  }
  const subtype = nonEmptyString(rawMessage.subtype);
  if (subtype !== "model_fallback" && subtype !== "model_refusal_fallback") {
    return null;
  }
  const originalModel = nonEmptyString(rawMessage.original_model);
  const fallbackModel = nonEmptyString(rawMessage.fallback_model);
  if (originalModel === null || fallbackModel === null) {
    return null;
  }

  return {
    originalModel,
    fallbackModel,
    reason: subtype === "model_refusal_fallback" ? "refusal" : "provider",
    message:
      nonEmptyString(rawMessage.content) ??
      `Switched from ${originalModel} to ${fallbackModel}.`,
  };
}

export function extractThreadTimelineModelFallback(
  events: readonly ThreadEventWithMeta[],
): ThreadTimelineModelFallback | null {
  let latestRelevantSeq = -1;
  let fallback: ThreadTimelineModelFallback | null = null;

  for (const { event, meta } of events) {
    if (meta.seq < latestRelevantSeq) {
      continue;
    }
    if (event.type === "client/turn/requested") {
      latestRelevantSeq = meta.seq;
      fallback = null;
      continue;
    }
    const eventFallback = getProviderModelFallbackData(event);
    if (eventFallback === null) {
      continue;
    }
    latestRelevantSeq = meta.seq;
    fallback = {
      sourceSeq: meta.seq,
      detectedAt: meta.createdAt,
      ...eventFallback,
    };
  }

  return fallback;
}
