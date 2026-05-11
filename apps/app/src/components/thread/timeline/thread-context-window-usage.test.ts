import { describe, expect, it } from "vitest";
import {
  calculateContextWindowUsagePercent,
  formatCompactTokenCount,
} from "@/components/thread/timeline/thread-context-window-usage";

describe("thread context window usage display helpers", () => {
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
