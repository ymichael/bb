import { describe, expect, it } from "vitest";
import {
  createProviderEventEnvelope,
  decodeProviderEventEnvelope,
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

  it("normalizes event types for lookup keys", () => {
    expect(normalizeThreadEventType("item/agentMessage/delta")).toBe(
      "item/agentmessage/delta",
    );
    expect(normalizeThreadEventType("turn.completed")).toBe("turn/completed");
  });
});
