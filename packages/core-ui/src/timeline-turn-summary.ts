import type { TimelineGroupedRowStatus } from "@bb/domain";
import { assertNever } from "./assert-never.js";

export interface TurnSummaryParts {
  prefix: string;
  emphasis: string;
}

export function formatTurnSummaryCountLabel(summaryCount: number): string {
  return `${summaryCount} item${summaryCount === 1 ? "" : "s"}`;
}

export function buildTurnSummaryParts({
  duration,
  status,
  summaryCount,
}: {
  duration: string | undefined;
  status: TimelineGroupedRowStatus;
  summaryCount: number;
}): TurnSummaryParts {
  const prefix = (() => {
    switch (status) {
      case "pending":
        return duration ? "Working for" : "Working on";
      case "error":
        return duration ? "Worked for" : "Worked on";
      case "interrupted":
        return duration ? "Stopped after" : "Stopped while working on";
      case "completed":
        return duration ? "Worked for" : "Worked on";
      default:
        return assertNever(status);
    }
  })();
  const countLabel = formatTurnSummaryCountLabel(summaryCount);

  if (duration) {
    return {
      prefix,
      emphasis: duration,
    };
  }

  return {
    prefix,
    emphasis: countLabel,
  };
}
