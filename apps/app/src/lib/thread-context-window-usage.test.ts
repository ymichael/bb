import {
  createProviderEventEnvelope,
  type ThreadEvent,
} from "@bb/core";
import { describe, expect, it } from "vitest";
import {
  calculateContextWindowUsagePercent,
  extractThreadContextWindowUsage,
  formatCompactTokenCount,
} from "./thread-context-window-usage";

const EMPTY_TOKEN_BREAKDOWN = {
  totalTokens: 0,
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  reasoningOutputTokens: 0,
};

function buildProviderEvent({
  seq,
  method,
  type = "thread/tokenUsage/updated",
  payload,
}: {
  seq: number;
  method: string;
  type?: ThreadEvent["type"];
  payload: unknown;
}): ThreadEvent {
  return {
    id: `event-${seq}`,
    threadId: "thread-1",
    seq,
    type,
    data: createProviderEventEnvelope({
      providerId: "codex",
      method,
      payload,
    }),
    createdAt: seq,
  };
}

describe("thread context window usage helpers", () => {
  it("extracts usage from the latest thread/tokenUsage/updated event", () => {
    const usage = extractThreadContextWindowUsage([
      buildProviderEvent({
        seq: 1,
        method: "thread/tokenUsage/updated",
        payload: {
          threadId: "provider-thread",
          turnId: "turn-1",
          tokenUsage: {
            total: {
              ...EMPTY_TOKEN_BREAKDOWN,
              totalTokens: 50000,
            },
            last: {
              ...EMPTY_TOKEN_BREAKDOWN,
              totalTokens: 9000,
            },
            modelContextWindow: 258400,
          },
        },
      }),
      buildProviderEvent({
        seq: 2,
        method: "thread/tokenUsage/updated",
        payload: {
          threadId: "provider-thread",
          turnId: "turn-2",
          tokenUsage: {
            total: {
              ...EMPTY_TOKEN_BREAKDOWN,
              totalTokens: 62000,
            },
            last: {
              ...EMPTY_TOKEN_BREAKDOWN,
              totalTokens: 32000,
            },
            modelContextWindow: 258400,
          },
        },
      }),
    ]);

    expect(usage).toEqual({
      totalTokens: 32000,
      modelContextWindow: 258400,
    });
  });

  it("falls back to cumulative usage when last usage is missing", () => {
    const usage = extractThreadContextWindowUsage([
      buildProviderEvent({
        seq: 1,
        method: "thread/tokenUsage/updated",
        payload: {
          threadId: "provider-thread",
          turnId: "turn-1",
          tokenUsage: {
            total: {
              ...EMPTY_TOKEN_BREAKDOWN,
              totalTokens: 4800,
            },
            last: null,
            modelContextWindow: 128000,
          },
        },
      }),
    ]);

    expect(usage).toEqual({
      totalTokens: 4800,
      modelContextWindow: 128000,
    });
  });

  it("prefers last token usage over cumulative token usage for context sizing", () => {
    const usage = extractThreadContextWindowUsage([
      buildProviderEvent({
        seq: 1,
        method: "thread/tokenUsage/updated",
        payload: {
          threadId: "provider-thread",
          turnId: "turn-9",
          tokenUsage: {
            total: {
              ...EMPTY_TOKEN_BREAKDOWN,
              totalTokens: 9000000,
            },
            last: {
              ...EMPTY_TOKEN_BREAKDOWN,
              totalTokens: 120000,
            },
            modelContextWindow: 258400,
          },
        },
      }),
    ]);

    expect(usage).toEqual({
      totalTokens: 120000,
      modelContextWindow: 258400,
    });
  });

  it("returns null when context window data is unavailable", () => {
    const usage = extractThreadContextWindowUsage([
      buildProviderEvent({
        seq: 1,
        method: "thread/tokenUsage/updated",
        payload: {
          threadId: "provider-thread",
          turnId: "turn-1",
          tokenUsage: {
            total: {
              ...EMPTY_TOKEN_BREAKDOWN,
              totalTokens: 1000,
            },
            last: {
              ...EMPTY_TOKEN_BREAKDOWN,
              totalTokens: 1000,
            },
            modelContextWindow: null,
          },
        },
      }),
    ]);

    expect(usage).toBeNull();
  });

  it("ignores legacy codex/event token_count payloads", () => {
    const usage = extractThreadContextWindowUsage([
      buildProviderEvent({
        seq: 1,
        method: "codex/event/token_count",
        payload: {
          id: "turn-legacy",
          msg: {
            type: "token_count",
            info: {
              total_token_usage: { total_tokens: 5000 },
              model_context_window: 128000,
            },
          },
        },
      }),
    ]);

    expect(usage).toBeNull();
  });

  it("formats compact token labels and usage percentages", () => {
    expect(formatCompactTokenCount(258400)).toBe("258k");
    expect(formatCompactTokenCount(999)).toBe("999");
    expect(calculateContextWindowUsagePercent({
      totalTokens: 32000,
      modelContextWindow: 258400,
    })).toBe(12);
  });
});
