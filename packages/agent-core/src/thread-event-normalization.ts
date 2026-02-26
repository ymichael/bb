import {
  PROVIDER_EVENT_ENVELOPE_SCHEMA,
  PROVIDER_EVENT_ENVELOPE_VERSION,
  type PersistedThreadEventData,
  type ProviderEventEnvelope,
} from "./types.js";
import { getStringField, toRecord } from "./unknown-helpers.js";

export interface CreateProviderEventEnvelopeArgs<TPayload = unknown> {
  providerId: string;
  method: string;
  payload: TPayload;
  observedAt?: number;
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
  const root = toRecord(unwrapProviderEventPayload(data));
  if (!root) return undefined;

  const direct =
    getStringField(root, "turnId") ??
    getStringField(root, "turn_id");
  if (direct) return direct;

  const turn = toRecord(root.turn);
  const turnId = getStringField(turn, "id");
  if (turnId) return turnId;

  const msg = toRecord(root.msg);
  const msgTurnId =
    getStringField(msg, "turn_id") ??
    getStringField(msg, "turnId");
  if (msgTurnId) return msgTurnId;

  const payload = toRecord(root.payload);
  if (!payload) return undefined;

  return (
    getStringField(payload, "turnId") ??
    getStringField(payload, "turn_id") ??
    getStringField(toRecord(payload.turn), "id") ??
    getStringField(toRecord(payload.msg), "turn_id") ??
    getStringField(toRecord(payload.msg), "turnId")
  );
}

export function extractProviderThreadIdFromPersistedEventData(
  data: PersistedThreadEventData | unknown,
): string | undefined {
  const root = toRecord(unwrapProviderEventPayload(data));
  if (!root) return undefined;

  const candidates = [
    root,
    toRecord(root.msg),
    toRecord(root.thread),
    toRecord(root.payload),
    toRecord(toRecord(root.payload)?.msg),
    toRecord(toRecord(root.payload)?.thread),
  ];

  for (const candidate of candidates) {
    if (!candidate) continue;

    const threadId =
      getStringField(candidate, "threadId") ??
      getStringField(candidate, "thread_id") ??
      getStringField(candidate, "conversationId") ??
      getStringField(candidate, "conversation_id");
    if (threadId) return threadId;

    const thread = toRecord(candidate.thread);
    const nestedThreadId = getStringField(thread, "id");
    if (nestedThreadId) return nestedThreadId;
  }

  return undefined;
}
