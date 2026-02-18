import type { Thread, ThreadEvent, UIMessage } from "@beanbag/core";

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function getStringField(
  record: Record<string, unknown> | null,
  key: string,
): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function normalizeEventType(type: string): string {
  return type.toLowerCase().replaceAll(".", "/");
}

function isTurnStartedEventType(type: string): boolean {
  return type === "turn/started" || type === "turn/start";
}

function isTurnCompletedEventType(type: string): boolean {
  return type === "turn/completed" || type === "turn/end";
}

function extractTurnIdFromThreadEventData(data: unknown): string | undefined {
  const root = asRecord(data);
  if (!root) return undefined;

  const direct =
    getStringField(root, "turnId") ??
    getStringField(root, "turn_id");
  if (direct) return direct;

  const turn = asRecord(root.turn);
  const turnId = getStringField(turn, "id");
  if (turnId) return turnId;

  const msg = asRecord(root.msg);
  const msgTurnId =
    getStringField(msg, "turn_id") ??
    getStringField(msg, "turnId");
  if (msgTurnId) return msgTurnId;

  const payload = asRecord(root.payload);
  if (!payload) return undefined;

  return (
    getStringField(payload, "turnId") ??
    getStringField(payload, "turn_id") ??
    getStringField(asRecord(payload.turn), "id") ??
    getStringField(asRecord(payload.msg), "turn_id") ??
    getStringField(asRecord(payload.msg), "turnId")
  );
}

function extractAgentMessageText(event: ThreadEvent): string | undefined {
  if (normalizeEventType(event.type) !== "item/completed") return undefined;
  const payload = asRecord(event.data);
  const item = asRecord(payload?.item);
  if (!item || item.type !== "agentMessage") return undefined;
  return typeof item.text === "string" && item.text.trim().length > 0
    ? item.text
    : undefined;
}

export function toTaskThreadTurnMessages(
  thread: Thread,
  events: ThreadEvent[],
): UIMessage[] {
  const sortedEvents = events.slice().sort((a, b) => a.seq - b.seq);
  const lastAgentMessageByTurn = new Map<
    string,
    { seq: number; createdAt: number; text: string }
  >();
  let activeTurnId: string | undefined;

  for (const event of sortedEvents) {
    const normalizedType = normalizeEventType(event.type);
    const explicitTurnId = extractTurnIdFromThreadEventData(event.data);

    if (isTurnStartedEventType(normalizedType) && explicitTurnId) {
      activeTurnId = explicitTurnId;
      continue;
    }

    if (isTurnCompletedEventType(normalizedType)) {
      activeTurnId = undefined;
      continue;
    }

    if (explicitTurnId) {
      activeTurnId = explicitTurnId;
    }

    const text = extractAgentMessageText(event);
    if (!text) continue;

    // Some providers omit turn IDs on item/completed; reuse the active lifecycle turn.
    const turnId = explicitTurnId ?? activeTurnId ?? `seq:${event.seq}`;
    lastAgentMessageByTurn.set(turnId, {
      seq: event.seq,
      createdAt: event.createdAt,
      text,
    });
  }

  return Array.from(lastAgentMessageByTurn.values())
    .sort((a, b) => (a.createdAt === b.createdAt ? a.seq - b.seq : a.createdAt - b.createdAt))
    .map((entry) => ({
      kind: "assistant-text" as const,
      id: `primary-thread-turn:${thread.id}:${entry.seq}`,
      threadId: thread.id,
      sourceSeqStart: entry.seq,
      sourceSeqEnd: entry.seq,
      createdAt: entry.createdAt,
      text: entry.text,
      status: "completed" as const,
    }));
}
