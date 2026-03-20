import type {
  Thread,
} from "@bb/core";
import { assertNever, getStringField, isThreadProviderId, toRecord } from "@bb/core";
import type {
  ProviderAdapter,
  ProviderToolCallRequest,
  ProviderToolCallResponse,
} from "@bb/provider-adapters";
import { createProviderAdapter } from "@bb/provider-adapters";

export interface NormalizedEnvironmentDaemonProviderEvent {
  providerId: string;
  normalizedMethod: string;
  shouldPersist: boolean;
  shouldBroadcast: boolean;
  nextStatus?: Thread["status"];
  title?: string;
  turnState?: "active" | "idle";
  turnId?: string;
}

export interface EnvironmentDaemonProviderSemantics {
  normalizeEvent(method: string, payload: unknown): NormalizedEnvironmentDaemonProviderEvent;
  decodeToolCallRequest(
    requestId: string | number,
    method: string,
    params: unknown,
  ): ProviderToolCallRequest | null;
  encodeToolCallResponse(response: ProviderToolCallResponse): Record<string, unknown>;
  extractThreadId(value: unknown): string | undefined;
  isMissingProviderThreadMessage(message: string): boolean;
}

function normalizeTitle(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) return undefined;
  if (normalized.length <= 60) return normalized;
  return `${normalized.slice(0, 57).trimEnd()}...`;
}

function toTurnState(
  normalizedMethod: string,
): "active" | "idle" | undefined {
  if (normalizedMethod === "turn/start" || normalizedMethod === "turn/started") {
    return "active";
  }
  if (normalizedMethod === "turn/completed" || normalizedMethod === "turn/end") {
    return "idle";
  }
  return undefined;
}

function decodeSharedToolCallRequest(
  requestId: string | number,
  method: string,
  params: unknown,
): ProviderToolCallRequest | null {
  if (method.toLowerCase().replaceAll(".", "/") !== "item/tool/call") {
    return null;
  }

  const record = toRecord(params);
  if (!record) return null;

  const threadId = getStringField(record, "threadId");
  const turnId = getStringField(record, "turnId");
  const callId = getStringField(record, "callId");
  const tool = getStringField(record, "tool");
  if (!threadId || !turnId || !callId || !tool) {
    return null;
  }

  return {
    requestId,
    threadId,
    turnId,
    callId,
    tool,
    arguments: record.arguments,
  };
}

function encodeSharedToolCallResponse(
  response: ProviderToolCallResponse,
): Record<string, unknown> {
  return {
    contentItems: response.contentItems.map((item) => {
      switch (item.type) {
        case "inputText":
          return { type: "inputText", text: item.text };
        case "inputImage":
          return { type: "inputImage", imageUrl: item.imageUrl };
        default:
          return assertNever(item);
      }
    }),
    success: response.success,
  };
}

function normalizeCommonEvent(
  provider: ProviderAdapter,
  method: string,
  payload: unknown,
): NormalizedEnvironmentDaemonProviderEvent {
  const normalizedMethod = provider.normalizeEventType(method);
  const turnState = toTurnState(normalizedMethod);
  const turnId = getStringField(toRecord(payload), "turnId") ?? undefined;
  const providerStatus = provider.statusForEvent(method, payload);
  const providerTitle = provider.titleFromEvent(method, payload);

  return {
    providerId: provider.id,
    normalizedMethod,
    shouldPersist: provider.shouldPersistEvent?.(method, payload) ?? true,
    shouldBroadcast: provider.shouldBroadcastForEvent(method),
    ...(providerStatus ? { nextStatus: providerStatus } : {}),
    ...(providerTitle ? { title: normalizeTitle(providerTitle) } : {}),
    ...(turnState ? { turnState } : {}),
    ...(turnId ? { turnId } : {}),
  };
}

function isMissingProviderThreadMessage(provider: ProviderAdapter, message: string): boolean {
  const normalized = message.toLowerCase();
  if (provider.id === "codex") {
    return (
      normalized.includes("no rollout found for thread id") ||
      normalized.includes("thread not found")
    );
  }
  return normalized.includes("thread not found");
}

function createProviderSemantics(provider: ProviderAdapter): EnvironmentDaemonProviderSemantics {
  return {
    normalizeEvent(method, payload) {
      return normalizeCommonEvent(provider, method, payload);
    },
    decodeToolCallRequest:
      provider.decodeToolCallRequest ?? decodeSharedToolCallRequest,
    encodeToolCallResponse:
      provider.encodeToolCallResponse ?? encodeSharedToolCallResponse,
    extractThreadId(value) {
      return (
        provider.extractThreadIdFromEventData(value) ??
        provider.extractThreadIdFromResult(value)
      );
    },
    isMissingProviderThreadMessage(message) {
      return isMissingProviderThreadMessage(provider, message);
    },
  };
}

export function getEnvironmentDaemonProviderSemantics(
  providerId: string | undefined,
): EnvironmentDaemonProviderSemantics | undefined {
  if (!providerId || !isThreadProviderId(providerId)) {
    return undefined;
  }
  return createProviderSemantics(createProviderAdapter({ providerId }));
}
