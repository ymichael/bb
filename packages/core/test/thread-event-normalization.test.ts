import { describe, expect, it } from "vitest";
import {
  createProviderEventEnvelope,
  decodeLooseTextContent,
  decodeProviderEventEnvelope,
  decodeThreadEventData,
  extractProviderThreadIdFromPersistedEventData,
  extractTurnIdFromPersistedEventData,
  normalizeThreadEventType,
  resolveProviderEventMethod,
  unwrapProviderEventPayload,
} from "../src/thread-event-normalization.js";

describe("thread event normalization", () => {
  it("decodes and unwraps provider envelopes", () => {
    const envelope = createProviderEventEnvelope({
      providerId: "codex",
      method: "item/completed",
      payload: {
        turnId: "turn-1",
        threadId: "provider-thread-1",
      },
      observedAt: 42,
    });

    const decoded = decodeProviderEventEnvelope(envelope);
    expect(decoded).toBeTruthy();
    expect(decoded?.__bb_provider_event.providerId).toBe("codex");
    expect(resolveProviderEventMethod("item/completed", envelope)).toBe(
      "item/completed",
    );
    expect(unwrapProviderEventPayload(envelope)).toEqual({
      turnId: "turn-1",
      threadId: "provider-thread-1",
    });
  });

  it("extracts turn and thread IDs from both envelope and legacy payload shapes", () => {
    const envelope = createProviderEventEnvelope({
      providerId: "codex",
      method: "turn/started",
      payload: {
        turn: { id: "turn-enveloped" },
        thread: { id: "thread-enveloped" },
      },
      observedAt: 1,
    });

    expect(extractTurnIdFromPersistedEventData(envelope)).toBe("turn-enveloped");
    expect(extractProviderThreadIdFromPersistedEventData(envelope)).toBe(
      "thread-enveloped",
    );

    expect(
      extractTurnIdFromPersistedEventData({
        msg: {
          turn_id: "turn-legacy",
        },
      }),
    ).toBe("turn-legacy");
    expect(
      extractProviderThreadIdFromPersistedEventData({
        conversation_id: "thread-legacy",
      }),
    ).toBe("thread-legacy");
  });

  it("does not treat Claude routing thread ids as provider session ids", () => {
    const envelope = createProviderEventEnvelope({
      providerId: "claude-code",
      method: "turn/completed",
      payload: {
        threadId: "bb-thread-1",
        turnId: "turn-1",
      },
      observedAt: 1,
    });

    expect(extractProviderThreadIdFromPersistedEventData(envelope)).toBeUndefined();
  });

  it("decodes a normalized event view from mixed legacy/provider shapes", () => {
    const decoded = decodeThreadEventData({
      payload: {
        msg: {
          turn_id: "turn-1",
          item_id: "item-1",
          item: {
            id: "item-1",
            type: "userMessage",
            content: [
              { type: "text", text: "hello " },
              { type: "image", data: { url: "https://example.com/a.png" } },
              { type: "localFile", path: "/tmp/note.txt" },
            ],
          },
        },
        thread: { id: "thread-1" },
      },
    });

    expect(decoded.turnId).toBe("turn-1");
    expect(decoded.providerThreadId).toBe("thread-1");
    expect(decoded.itemId).toBe("item-1");
    expect(decoded.item?.normalizedType).toBe("usermessage");
    expect(decoded.item?.content).toEqual([
      { type: "text", text: "hello " },
      { type: "image", imageUrl: "https://example.com/a.png" },
      { type: "local_file", path: "/tmp/note.txt" },
    ]);
  });

  it("centralizes tolerant text extraction for open_external provider payloads", () => {
    expect(
      decodeLooseTextContent({
        summary_text: [{ value: "alpha" }, { stdout: "beta" }],
      }).text,
    ).toBe("alphabeta");
  });

  it("normalizes event types for lookup keys", () => {
    expect(normalizeThreadEventType("item/agentMessage/delta")).toBe(
      "item/agentmessage/delta",
    );
    expect(normalizeThreadEventType("turn.completed")).toBe("turn/completed");
  });

  it("falls back to normalizedType when type is missing on item", () => {
    const decoded = decodeThreadEventData({
      payload: {
        turnId: "turn-1",
        item: {
          normalizedType: "toolcall",
          callId: "call-1",
          tool: "read_file",
        },
      },
    });

    expect(decoded.item).toBeTruthy();
    expect(decoded.item?.type).toBe("toolcall");
    expect(decoded.item?.normalizedType).toBe("toolcall");
  });

  it("prefers type over normalizedType on item", () => {
    const decoded = decodeThreadEventData({
      payload: {
        turnId: "turn-1",
        item: {
          type: "commandExecution",
          normalizedType: "toolcall",
          id: "call-1",
        },
      },
    });

    expect(decoded.item?.type).toBe("commandExecution");
    expect(decoded.item?.normalizedType).toBe("commandexecution");
  });
});
