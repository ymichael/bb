import { describe, expect, it } from "vitest";
import {
  canonicalizeProducerEventPayload,
  threadScope,
  turnScope,
} from "../src/index.js";

describe("canonicalizeProducerEventPayload", () => {
  it("uses stable object key ordering without semantic whitespace", () => {
    const left = canonicalizeProducerEventPayload({
      protocolVersion: 14,
      threadId: "thr_123",
      event: {
        type: "provider/unhandled",
        threadId: "thr_123",
        providerThreadId: "provider-thread",
        providerId: "codex",
        rawType: "raw",
        rawEvent: {
          jsonrpc: "2.0",
          method: "test",
          params: {
            z: true,
            a: {
              b: "value",
              a: [2, 1],
            },
          },
        },
        scope: threadScope(),
      },
    });
    const right = canonicalizeProducerEventPayload({
      protocolVersion: 14,
      threadId: "thr_123",
      event: {
        scope: threadScope(),
        rawEvent: {
          method: "test",
          params: {
            a: {
              a: [2, 1],
              b: "value",
            },
            z: true,
          },
          jsonrpc: "2.0",
        },
        rawType: "raw",
        providerId: "codex",
        providerThreadId: "provider-thread",
        threadId: "thr_123",
        type: "provider/unhandled",
      },
    });

    expect(right).toBe(left);
    expect(left).not.toContain(" ");
    expect(left).not.toContain("\n");
  });

  it("includes protocol version, thread id, event type, and payload semantics", () => {
    const base = canonicalizeProducerEventPayload({
      protocolVersion: 14,
      threadId: "thr_123",
      event: {
        type: "turn/started",
        threadId: "thr_123",
        providerThreadId: "provider-thread",
        scope: turnScope("turn_123"),
      },
    });

    expect(
      canonicalizeProducerEventPayload({
        protocolVersion: 15,
        threadId: "thr_123",
        event: {
          type: "turn/started",
          threadId: "thr_123",
          providerThreadId: "provider-thread",
          scope: turnScope("turn_123"),
        },
      }),
    ).not.toBe(base);
    expect(
      canonicalizeProducerEventPayload({
        protocolVersion: 14,
        threadId: "thr_456",
        event: {
          type: "turn/started",
          threadId: "thr_456",
          providerThreadId: "provider-thread",
          scope: turnScope("turn_123"),
        },
      }),
    ).not.toBe(base);
    expect(
      canonicalizeProducerEventPayload({
        protocolVersion: 14,
        threadId: "thr_123",
        event: {
          type: "turn/completed",
          threadId: "thr_123",
          providerThreadId: "provider-thread",
          status: "completed",
          scope: turnScope("turn_123"),
        },
      }),
    ).not.toBe(base);
  });
});
