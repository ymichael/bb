import type { TimelineGroupedRowStatus } from "@bb/domain";
import { assertNever } from "./assert-never.js";

function statusPriority(status: TimelineGroupedRowStatus): number {
  switch (status) {
    case "completed":
      return 0;
    case "interrupted":
      return 1;
    case "pending":
      return 2;
    case "error":
      return 3;
    default:
      return assertNever(status);
  }
}

export function mergeGroupedRowStatus(
  left: TimelineGroupedRowStatus,
  right: TimelineGroupedRowStatus,
): TimelineGroupedRowStatus {
  return statusPriority(left) >= statusPriority(right) ? left : right;
}
