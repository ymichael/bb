/**
 * Shared fallback helpers for provider events that do not yet have a
 * first-class translation path.
 */

import {
  providerRawEventSchema,
  type ProviderRawEvent,
  type ThreadEvent,
} from "@bb/domain";
import type {
  ProviderUnhandledEvent,
} from "@bb/domain";
import type { ProviderVisibilityMetadata } from "../provider-visibility.js";
import type { JsonRpcMessage } from "../provider-adapter.js";
import {
  getStringProperty,
  isRecord,
} from "./provider-visibility-helpers.js";

export interface CreateUnhandledProviderEventArgs {
  providerId: string;
  rawEvent: JsonRpcMessage;
  rawType: string;
  threadId?: string;
  providerThreadId?: string;
  turnId?: string;
  parentToolCallId?: string;
}

export interface BuildUnhandledProviderEventsArgs {
  providerId: string;
  rawEvent: JsonRpcMessage;
  visibilityMetadata: Pick<
    ProviderVisibilityMetadata,
    "describeParsedRawEvent" | "parseRawEvent"
  >;
  parentToolCallId?: string;
}

function toProviderRawEvent(
  rawEvent: JsonRpcMessage,
): ProviderRawEvent {
  const parsed = providerRawEventSchema.safeParse(rawEvent);
  if (parsed.success) {
    return parsed.data;
  }

  return {
    jsonrpc: "2.0",
    ...(rawEvent.id !== undefined ? { id: rawEvent.id } : {}),
    method: rawEvent.method,
    params: {
      serializationError: "Provider raw event params were not JSON-serializable.",
    },
  };
}

function getThreadIdFromRawEvent(rawEvent: JsonRpcMessage): string {
  if (!isRecord(rawEvent.params)) {
    return "";
  }
  return getStringProperty(rawEvent.params, "threadId") ?? "";
}

function getTurnIdFromRawEvent(rawEvent: JsonRpcMessage): string | undefined {
  if (!isRecord(rawEvent.params)) {
    return undefined;
  }
  return getStringProperty(rawEvent.params, "turnId");
}

export function createUnhandledProviderEvent(
  args: CreateUnhandledProviderEventArgs,
): ProviderUnhandledEvent {
  const threadId = args.threadId ?? getThreadIdFromRawEvent(args.rawEvent);
  const providerThreadId = args.providerThreadId ?? threadId;
  const turnId = args.turnId ?? getTurnIdFromRawEvent(args.rawEvent);

  return {
    type: "provider/unhandled",
    threadId,
    providerThreadId,
    providerId: args.providerId,
    rawType: args.rawType,
    rawEvent: toProviderRawEvent(args.rawEvent),
    ...(turnId ? { turnId } : {}),
    ...(args.parentToolCallId ? { parentToolCallId: args.parentToolCallId } : {}),
  };
}

export function buildUnhandledProviderEvents(
  args: BuildUnhandledProviderEventsArgs,
): ThreadEvent[] {
  const parsedRawEvent = args.visibilityMetadata.parseRawEvent(args.rawEvent);
  const description = args.visibilityMetadata.describeParsedRawEvent(parsedRawEvent);
  if (description.coverage !== "unknown") {
    return [];
  }

  return [
    createUnhandledProviderEvent({
      providerId: args.providerId,
      rawEvent: args.rawEvent,
      rawType: description.kind,
      ...(args.parentToolCallId
        ? { parentToolCallId: args.parentToolCallId }
        : {}),
    }),
  ];
}
