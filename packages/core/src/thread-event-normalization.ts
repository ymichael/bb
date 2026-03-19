import { assertNever } from "./assert-never.js";
import {
  PROVIDER_EVENT_ENVELOPE_SCHEMA,
  PROVIDER_EVENT_ENVELOPE_VERSION,
  type PersistedThreadEventData,
  type ProviderEventEnvelope,
} from "./types.js";
import {
  isThreadProviderId,
  type ThreadProviderId,
} from "./thread-provider.js";
import { getStringField, toRecord } from "./unknown-helpers.js";

export interface CreateProviderEventEnvelopeArgs<TPayload = unknown> {
  providerId: string;
  method: string;
  payload: TPayload;
  observedAt?: number;
}

export interface DecodedTextContent {
  fragments: string[];
  text: string;
}

export type DecodedProviderContentPart =
  | {
      type: "text";
      text: string;
    }
  | {
      type: "image";
      imageUrl?: string;
    }
  | {
      type: "local_image";
      path?: string;
    }
  | {
      type: "local_file";
      path?: string;
    }
  | {
      type: "unknown";
    };

export interface DecodedThreadEventItem {
  id?: string;
  type?: string;
  normalizedType: string;
  content: DecodedProviderContentPart[];
  text: DecodedTextContent;
  summaryText: DecodedTextContent;
  raw: Record<string, unknown>;
}

export interface DecodedThreadEventData {
  envelope: ProviderEventEnvelope["__bb_provider_event"] | null;
  payload: Record<string, unknown> | null;
  eventPayload: Record<string, unknown> | null;
  turnId?: string;
  providerThreadId?: string;
  itemId?: string;
  item: DecodedThreadEventItem | null;
}

function normalizeToken(value: string): string {
  return value.toLowerCase().replaceAll(/[^a-z0-9]/g, "");
}

function collectLooseTextFragments(value: unknown, out: string[]): void {
  if (typeof value === "string") {
    if (value.length > 0) out.push(value);
    return;
  }

  if (Array.isArray(value)) {
    for (const entry of value) collectLooseTextFragments(entry, out);
    return;
  }

  const record = toRecord(value);
  if (!record) return;

  const candidates = [
    record.delta,
    record.text,
    record.content,
    record.value,
    record.message,
    record.summary,
    record.summary_text,
    record.summaryText,
    record.stdout,
    record.stderr,
    record.aggregated_output,
    record.aggregatedOutput,
  ];

  for (const candidate of candidates) {
    if (candidate === undefined) continue;
    collectLooseTextFragments(candidate, out);
  }
}

function decodeContentPart(value: unknown): DecodedProviderContentPart | null {
  const record = toRecord(value);
  if (!record) return null;

  const type = getStringField(record, "type");
  const normalizedType = type ? normalizeToken(type) : "";
  const data = toRecord(record.data);

  switch (normalizedType) {
    case "text": {
      const text = decodeLooseTextContent(record.text).text;
      if (!text) return null;
      return { type: "text", text };
    }
    case "image":
      return {
        type: "image",
        imageUrl:
          getStringField(record, "image_url") ??
          getStringField(record, "url") ??
          getStringField(data, "image_url") ??
          getStringField(data, "url"),
      };
    case "localimage":
      return {
        type: "local_image",
        path: getStringField(record, "path") ?? getStringField(data, "path"),
      };
    case "localfile":
      return {
        type: "local_file",
        path: getStringField(record, "path") ?? getStringField(data, "path"),
      };
    default:
      // Provider content part types are open_external; unknown variants are preserved
      // as opaque parts instead of being rejected.
      return { type: "unknown" };
  }
}

function decodeItemContent(value: unknown): DecodedProviderContentPart[] {
  if (!Array.isArray(value)) return [];
  const parts: DecodedProviderContentPart[] = [];
  for (const entry of value) {
    const part = decodeContentPart(entry);
    if (part) parts.push(part);
  }
  return parts;
}

export function decodeLooseTextContent(value: unknown): DecodedTextContent {
  const fragments: string[] = [];
  collectLooseTextFragments(value, fragments);
  return {
    fragments,
    text: fragments.join(""),
  };
}

function getNestedRecordCandidates(
  root: Record<string, unknown>,
): Record<string, unknown>[] {
  const msg = toRecord(root.msg);
  const payload = toRecord(root.payload);
  const payloadMsg = toRecord(payload?.msg);
  return [root, msg, payload, payloadMsg].filter(
    (candidate): candidate is Record<string, unknown> => candidate !== null,
  );
}

function shouldUseLooseThreadIdAsProviderThreadId(
  providerId: string | undefined,
): boolean {
  if (!providerId || !isThreadProviderId(providerId)) return false;
  const normalizedProviderId: ThreadProviderId = providerId;
  switch (normalizedProviderId) {
    case "codex":
    case "pi":
      return true;
    case "claude-code":
      return false;
    default:
      return assertNever(normalizedProviderId);
  }
}

function decodeItem(root: Record<string, unknown>): DecodedThreadEventItem | null {
  const candidates = getNestedRecordCandidates(root);
  const rawItem =
    candidates.map((candidate) => toRecord(candidate.item)).find(Boolean) ?? null;
  if (!rawItem) return null;

  const type = getStringField(rawItem, "type") ?? getStringField(rawItem, "normalizedType");
  return {
    id: getStringField(rawItem, "id"),
    type,
    normalizedType: type ? normalizeToken(type) : "",
    content: decodeItemContent(rawItem.content),
    text: decodeLooseTextContent(rawItem.text ?? rawItem.content),
    summaryText: decodeLooseTextContent(
      rawItem.summary ?? rawItem.summaryText ?? rawItem.summary_text,
    ),
    raw: rawItem,
  };
}

export function decodeThreadEventData(
  data: PersistedThreadEventData | unknown,
): DecodedThreadEventData {
  const envelope = decodeProviderEventEnvelope(data);
  const payload = toRecord(envelope ? envelope.payload : data);
  if (!payload) {
    return {
      envelope: envelope?.__bb_provider_event ?? null,
      payload: null,
      eventPayload: null,
      item: null,
    };
  }

  const candidates = getNestedRecordCandidates(payload);
  const allowLooseThreadIdFallback = shouldUseLooseThreadIdAsProviderThreadId(
    envelope?.__bb_provider_event.providerId,
  );
  const turnId =
    candidates
      .map((candidate) => {
        return (
          getStringField(candidate, "turnId") ??
          getStringField(candidate, "turn_id") ??
          getStringField(toRecord(candidate.turn), "id")
        );
      })
      .find((value): value is string => Boolean(value)) ??
    getStringField(payload, "id") ??
    undefined;

  const providerThreadId =
    candidates
      .map((candidate) => {
        return (
          getStringField(candidate, "providerThreadId") ??
          getStringField(candidate, "conversationId") ??
          getStringField(candidate, "conversation_id") ??
          (allowLooseThreadIdFallback
            ? (
                getStringField(candidate, "threadId") ??
                getStringField(candidate, "thread_id")
              )
            : undefined) ??
          getStringField(toRecord(candidate.thread), "id")
        );
      })
      .find((value): value is string => Boolean(value)) ?? undefined;

  const item = decodeItem(payload);
  const itemId =
    item?.id ??
    candidates
      .map((candidate) => {
        return (
          getStringField(candidate, "itemId") ??
          getStringField(candidate, "item_id")
        );
      })
      .find((value): value is string => Boolean(value)) ??
    undefined;

  return {
    envelope: envelope?.__bb_provider_event ?? null,
    payload,
    eventPayload: toRecord(payload.msg) ?? payload,
    turnId,
    providerThreadId,
    itemId,
    item,
  };
}

function decodeProviderEventEnvelopeMeta(
  value: unknown,
): ProviderEventEnvelope["__bb_provider_event"] | null {
  const record = toRecord(value);
  if (!record) return null;
  if (record.schema !== PROVIDER_EVENT_ENVELOPE_SCHEMA) return null;
  if (record.version !== PROVIDER_EVENT_ENVELOPE_VERSION) return null;
  const providerId = getStringField(record, "providerId");
  const method = getStringField(record, "method");
  const observedAt = record.observedAt;
  if (!providerId || !method) return null;
  if (typeof observedAt !== "number" || !Number.isFinite(observedAt)) return null;
  return {
    schema: PROVIDER_EVENT_ENVELOPE_SCHEMA,
    version: PROVIDER_EVENT_ENVELOPE_VERSION,
    providerId,
    method,
    observedAt,
  };
}

export function createProviderEventEnvelope<TPayload = unknown>(
  args: CreateProviderEventEnvelopeArgs<TPayload>,
): ProviderEventEnvelope<TPayload> {
  return {
    __bb_provider_event: {
      schema: PROVIDER_EVENT_ENVELOPE_SCHEMA,
      version: PROVIDER_EVENT_ENVELOPE_VERSION,
      providerId: args.providerId,
      method: args.method,
      observedAt: args.observedAt ?? Date.now(),
    },
    payload: args.payload,
  };
}

export function decodeProviderEventEnvelope(
  data: unknown,
): ProviderEventEnvelope | null {
  const record = toRecord(data);
  if (!record) return null;
  const meta = decodeProviderEventEnvelopeMeta(record.__bb_provider_event);
  if (!meta) return null;
  return {
    __bb_provider_event: meta,
    payload: record.payload,
  };
}

export function isProviderEventEnvelope(
  data: unknown,
): data is ProviderEventEnvelope {
  return decodeProviderEventEnvelope(data) !== null;
}

export function unwrapProviderEventPayload(data: unknown): unknown {
  const envelope = decodeProviderEventEnvelope(data);
  if (!envelope) return data;
  return envelope.payload;
}

export function resolveProviderEventMethod(
  fallbackEventType: string,
  data: PersistedThreadEventData | unknown,
): string {
  const envelope = decodeProviderEventEnvelope(data);
  if (!envelope) return fallbackEventType;
  return envelope.__bb_provider_event.method;
}

export function normalizeThreadEventType(type: string): string {
  return type.toLowerCase().replaceAll(".", "/");
}

export function extractTurnIdFromPersistedEventData(
  data: PersistedThreadEventData | unknown,
): string | undefined {
  return decodeThreadEventData(data).turnId;
}

export function extractProviderThreadIdFromPersistedEventData(
  data: PersistedThreadEventData | unknown,
): string | undefined {
  return decodeThreadEventData(data).providerThreadId;
}
