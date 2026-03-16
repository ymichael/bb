import {
  extractThreadContextWindowUsage as extractThreadContextWindowUsageFromEvents,
  type ThreadContextWindowUsage,
} from "@bb/core";

export type { ThreadContextWindowUsage };

const TOKEN_COMPACT_FORMATTER = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 0,
});

export const extractThreadContextWindowUsage = extractThreadContextWindowUsageFromEvents;

export function calculateContextWindowUsagePercent(usage: ThreadContextWindowUsage): number {
  if (usage.modelContextWindow <= 0) return 0;
  const ratio = usage.totalTokens / usage.modelContextWindow;
  const clampedRatio = Math.min(Math.max(ratio, 0), 1);
  return Math.round(clampedRatio * 100);
}

export function formatCompactTokenCount(value: number): string {
  const safeValue = Math.max(0, Math.round(value));
  return TOKEN_COMPACT_FORMATTER.format(safeValue).toLowerCase();
}
