import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  parseStoredThreadEvent,
  parseThreadEventRow,
} from "../src/stored-thread-event.js";
import { threadScope, turnScope } from "../src/thread-event-scope.js";
import { systemThreadInterruptedEventDataSchema } from "../src/thread-events.js";

describe("parseStoredThreadEvent", () => {
  it("rejects assistant deltas without an itemId", () => {
    expect(() =>
      parseStoredThreadEvent({
        type: "item/agentMessage/delta",
        threadId: "thread-1",
        providerThreadId: "provider-1",
        scope: turnScope("turn-1"),
        data: {
          delta: "partial reply",
        },
      }),
    ).toThrow();
  });

  it("requires stored rows to carry explicit scope", () => {
    expect(() =>
      parseThreadEventRow({
        id: "evt-1",
        type: "thread/started",
        threadId: "thread-1",
        seq: 1,
        data: {},
        createdAt: 1,
      }),
    ).toThrow(/scope/);
  });

  it("defaults missing senderThreadId on pre-existing client/turn/requested rows", () => {
    const event = parseStoredThreadEvent({
      type: "client/turn/requested",
      threadId: "thread-1",
      scope: threadScope(),
      data: {
        direction: "outbound",
        requestId: "creq_23456789ab",
        source: "tell",
        initiator: "user",
        input: [{ type: "text", text: "pre-existing message" }],
        target: { kind: "new-turn" },
        request: { method: "turn/start", params: {} },
        execution: {
          model: "gpt-5",
          serviceTier: "default",
          reasoningLevel: "medium",
          permissionMode: "full",
          source: "client/turn/requested",
        },
      },
    });

    expect(event).toMatchObject({
      type: "client/turn/requested",
      initiator: "user",
      senderThreadId: null,
    });
  });

  it("rejects a retry marker carrying one of its two keys", () => {
    const base = {
      direction: "outbound",
      requestId: "creq_23456789ab",
      source: "tell",
      initiator: "system",
      input: [{ type: "text", text: "retry" }],
      target: { kind: "new-turn" },
      request: { method: "turn/start", params: {} },
      execution: {
        model: "gpt-5",
        serviceTier: "default",
        reasoningLevel: "medium",
        permissionMode: "full",
        source: "client/turn/requested",
      },
    };
    const parse = (marker: Record<string, unknown>) =>
      parseStoredThreadEvent({
        type: "client/turn/requested",
        threadId: "thread-1",
        scope: threadScope(),
        data: { ...base, ...marker },
      });

    // The marker is one fact in two keys: an attempt number without the
    // request it re-runs (or vice versa) misstates retry ancestry.
    expect(() => parse({ retryAttempt: 2 })).toThrow();
    expect(() => parse({ retryOfRequestId: "creq_23456789cd" })).toThrow();
    expect(
      parse({ retryOfRequestId: "creq_23456789cd", retryAttempt: 2 }),
    ).toMatchObject({ retryOfRequestId: "creq_23456789cd", retryAttempt: 2 });
    expect(parse({})).toMatchObject({ initiator: "system" });
  });

  it.each(["workspace-write", "readonly"] as const)(
    "preserves the legacy %s mode on stored history",
    (permissionMode) => {
      const event = parseStoredThreadEvent({
        type: "client/turn/requested",
        threadId: "thread-1",
        scope: threadScope(),
        data: {
          direction: "outbound",
          requestId: "creq_23456789ab",
          source: "tell",
          initiator: "user",
          input: [{ type: "text", text: "historical message" }],
          target: { kind: "new-turn" },
          request: { method: "turn/start", params: {} },
          execution: {
            model: "gpt-5",
            serviceTier: "default",
            reasoningLevel: "medium",
            permissionMode,
            source: "client/turn/requested",
          },
        },
      });

      expect(event).toMatchObject({
        type: "client/turn/requested",
        execution: { permissionMode },
      });
    },
  );

  it("drops legacy data turnId and uses stored scope as ground truth", () => {
    const event = parseStoredThreadEvent({
      type: "item/completed",
      threadId: "thread-1",
      providerThreadId: "provider-1",
      scope: turnScope("turn-from-scope"),
      data: {
        turnId: "turn-from-data",
        item: {
          type: "agentMessage",
          id: "assistant-1",
          text: "Hello.",
        },
      },
    });

    expect(event).toMatchObject({
      type: "item/completed",
      scope: turnScope("turn-from-scope"),
    });
    expect(event).not.toHaveProperty("turnId");
  });

  it("keeps host connection loss compatible with legacy interruption readers", () => {
    const data = {
      reason: "host-daemon-restarted",
      cause: "host-connection-lost",
    } as const;

    expect(systemThreadInterruptedEventDataSchema.parse(data)).toEqual(data);

    const legacySchema = z.object({
      reason: z.enum([
        "manual-stop",
        "host-daemon-restarted",
        "provider-turn-idle",
      ]),
    });
    expect(legacySchema.parse(data)).toEqual({
      reason: "host-daemon-restarted",
    });
  });
});
