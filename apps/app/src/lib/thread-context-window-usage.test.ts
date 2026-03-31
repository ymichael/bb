import {
  buildThreadEventRow,
  type ThreadEventTokenUsage,
  type ThreadEventRow,
} from "@bb/domain";
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
  tokenUsage,
  turnId,
}: {
  seq: number;
  tokenUsage: ThreadEventTokenUsage;
  turnId: string;
}): ThreadEventRow {
  return buildThreadEventRow({
    id: `event-${seq}`,
    threadId: "thread-1",
    seq,
    createdAt: seq,
    event: {
      type: "thread/tokenUsage/updated",
      threadId: "thread-1",
      providerThreadId: "provider-thread",
      turnId,
      tokenUsage,
    },
  });
}

describe("thread context window usage helpers", () => {
  it("extracts usage from the latest thread/tokenUsage/updated event", () => {
    const usage = extractThreadContextWindowUsage([
      buildProviderEvent({
        seq: 1,
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
      }),
      buildProviderEvent({
        seq: 2,
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
      }),
    ]);

    expect(usage).toEqual({
      totalTokens: 32000,
      modelContextWindow: 258400,
    });
  });

  it("uses the last token usage for context sizing", () => {
    const usage = extractThreadContextWindowUsage([
      buildProviderEvent({
        seq: 1,
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
