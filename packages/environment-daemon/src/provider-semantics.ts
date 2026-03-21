import type {
  Thread,
} from "@bb/core";
import { assertNever, decodeThreadIdFromWireValue, getStringField, isThreadProviderId, toRecord } from "@bb/core";
import type {
  BbProviderEvent,
  ProviderToolCallRequest,
  ProviderToolCallResponse,
} from "@bb/core";
import { createProviderAdapter, type ProviderAdapter } from "@bb/provider-adapters";

// ---------------------------------------------------------------------------
// BbProviderEvent → bb-owned policy
//
// These functions derive persist/broadcast/status policy from the canonical
// event type. The adapter translates SDK events into BbProviderEvent, and
// bb decides what to do with them.
// ---------------------------------------------------------------------------

function shouldPersistEvent(event: BbProviderEvent): boolean {
  switch (event.type) {
    case "item/agentMessage/delta":
    case "item/commandExecution/outputDelta":
    case "item/fileChange/outputDelta":
    case "item/reasoning/summaryTextDelta":
    case "item/reasoning/textDelta":
    case "item/plan/delta":
    case "item/mcpToolCall/progress":
    case "thread/name/updated":
    case "warning":
      return false;
    default:
      return true;
  }
}

function shouldBroadcastEvent(event: BbProviderEvent): boolean {
  switch (event.type) {
    case "item/agentMessage/delta":
    case "item/reasoning/summaryTextDelta":
    case "item/reasoning/textDelta":
      return false;
    default:
      return true;
  }
}

function statusFromEvent(event: BbProviderEvent): Thread["status"] | undefined {
  switch (event.type) {
    case "turn/started":
      return "active";
    case "turn/completed":
      return event.status === "failed" ? "error" : "idle";
    case "error":
      return "error";
    default:
      return undefined;
  }
}

function turnStateFromEvent(event: BbProviderEvent): "active" | "idle" | undefined {
  switch (event.type) {
    case "turn/started":
      return "active";
    case "turn/completed":
      return "idle";
    default:
      return undefined;
  }
}

function titleFromEvent(event: BbProviderEvent): string | undefined {
  if (event.type === "thread/name/updated") return event.threadName;
  return undefined;
}

function turnIdFromEvent(event: BbProviderEvent): string | undefined {
  if ("turnId" in event && typeof event.turnId === "string") return event.turnId;
  return undefined;
}

function providerThreadIdFromEvent(event: BbProviderEvent): string | undefined {
  if (event.type === "thread/identity") return event.providerThreadId;
  return undefined;
}

// ---------------------------------------------------------------------------
// Provider semantics — wraps adapter for env-daemon use
// ---------------------------------------------------------------------------

export interface NormalizedEnvironmentDaemonProviderEvent {
  providerId: string;
  bbEvents: BbProviderEvent[];
  /** First event's type as a canonical method string. */
  normalizedMethod: string;
  shouldPersist: boolean;
  shouldBroadcast: boolean;
  nextStatus?: Thread["status"];
  title?: string;
  turnState?: "active" | "idle";
  turnId?: string;
  providerThreadId?: string;
}

export interface EnvironmentDaemonProviderSemantics {
  translateEvent(event: unknown): NormalizedEnvironmentDaemonProviderEvent;
  decodeToolCallRequest(
    requestId: string | number,
    method: string,
    params: unknown,
  ): ProviderToolCallRequest | null;
  encodeToolCallResponse(response: ProviderToolCallResponse): Record<string, unknown>;
  extractThreadId(value: unknown): string | undefined;
  isMissingProviderThreadMessage(message: string): boolean;
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

function isMissingProviderThreadMessage(providerId: string, message: string): boolean {
  const normalized = message.toLowerCase();
  if (providerId === "codex") {
    return (
      normalized.includes("no rollout found for thread id") ||
      normalized.includes("thread not found")
    );
  }
  return normalized.includes("thread not found");
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function createProviderSemantics(provider: ProviderAdapter<any, any>): EnvironmentDaemonProviderSemantics {
  return {
    translateEvent(event: unknown): NormalizedEnvironmentDaemonProviderEvent {
      const bbEvents = provider.translateEvent(event);

      // Derive policy from the first event (most events translate 1:1)
      const primary = bbEvents[0];
      const persist = primary ? shouldPersistEvent(primary) : true;
      const broadcast = primary ? shouldBroadcastEvent(primary) : true;
      const status = primary ? statusFromEvent(primary) : undefined;
      const title = bbEvents.find((e) => titleFromEvent(e) !== undefined);
      const turnState = primary ? turnStateFromEvent(primary) : undefined;

      // Collect providerThreadId from any thread/identity event
      let ptid: string | undefined;
      for (const e of bbEvents) {
        const id = providerThreadIdFromEvent(e);
        if (id) { ptid = id; break; }
      }

      return {
        providerId: provider.id,
        bbEvents,
        normalizedMethod: primary?.type ?? "",
        shouldPersist: persist,
        shouldBroadcast: broadcast,
        ...(status ? { nextStatus: status } : {}),
        ...(title ? { title: titleFromEvent(title) } : {}),
        ...(turnState ? { turnState } : {}),
        ...(primary ? { turnId: turnIdFromEvent(primary) } : {}),
        ...(ptid ? { providerThreadId: ptid } : {}),
      };
    },
    decodeToolCallRequest(requestId, method, params) {
      return provider.decodeToolCallRequest({ requestId, method, params: toRecord(params) ?? {} });
    },
    encodeToolCallResponse(response) {
      return encodeSharedToolCallResponse(provider.encodeToolCallResponse(response));
    },
    extractThreadId(value) {
      return decodeThreadIdFromWireValue(value);
    },
    isMissingProviderThreadMessage(message) {
      return isMissingProviderThreadMessage(provider.id, message);
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
