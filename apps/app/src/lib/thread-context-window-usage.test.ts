import {
  buildThreadEventRow,
  turnScope,
  type ThreadEventContextWindowUsage,
  type ThreadEventRow,
} from "@bb/domain";
import { describe, expect, it } from "vitest";
import {
  calculateContextWindowUsagePercent,
  extractThreadContextWindowUsage,
  formatCompactTokenCount,
} from "./thread-context-window-usage";

function buildProviderEvent({
  contextWindowUsage,
  seq,
  turnId,
}: {
  contextWindowUsage: ThreadEventContextWindowUsage;
  seq: number;
  turnId: string;
}): ThreadEventRow {
  const scope = turnScope(turnId);
  return buildThreadEventRow({
    id: `event-${seq}`,
    scope,
    threadId: "thread-1",
    seq,
    createdAt: seq,
    event: {
      type: "thread/contextWindowUsage/updated",
      threadId: "thread-1",
      providerThreadId: "provider-thread",
      turnId,
      scope,
      contextWindowUsage,
    },
  });
}

describe("thread context window usage helpers", () => {
  it("extracts usage from the latest thread/contextWindowUsage/updated event", () => {
    const usage = extractThreadContextWindowUsage([
      buildProviderEvent({
        seq: 1,
        turnId: "turn-1",
        contextWindowUsage: {
          usedTokens: 9000,
          modelContextWindow: 258400,
          estimated: false,
        },
      }),
      buildProviderEvent({
        seq: 2,
        turnId: "turn-2",
        contextWindowUsage: {
          usedTokens: 32000,
          modelContextWindow: 258400,
          estimated: true,
        },
      }),
    ]);

    expect(usage).toEqual({
      usedTokens: 32000,
      modelContextWindow: 258400,
      estimated: true,
    });
  });

  it("keeps the latest explicit unknown usage from reusing older used tokens", () => {
    const usage = extractThreadContextWindowUsage([
      buildProviderEvent({
        seq: 1,
        turnId: "turn-1",
        contextWindowUsage: {
          usedTokens: 120000,
          modelContextWindow: 258400,
          estimated: false,
        },
      }),
      buildProviderEvent({
        seq: 2,
        turnId: "turn-2",
        contextWindowUsage: {
          usedTokens: null,
          modelContextWindow: 258400,
          estimated: true,
        },
      }),
    ]);

    expect(usage).toBeNull();
  });

  it("returns null when context window data is unavailable", () => {
    const usage = extractThreadContextWindowUsage([
      buildProviderEvent({
        seq: 1,
        turnId: "turn-1",
        contextWindowUsage: {
          usedTokens: 1000,
          modelContextWindow: null,
          estimated: false,
        },
      }),
    ]);

    expect(usage).toBeNull();
  });

  it("formats compact token labels and usage percentages", () => {
    expect(formatCompactTokenCount(258400)).toBe("258k");
    expect(formatCompactTokenCount(999)).toBe("999");
    expect(
      calculateContextWindowUsagePercent({
        usedTokens: 32000,
        modelContextWindow: 258400,
        estimated: false,
      }),
    ).toBe(12);
  });
});
