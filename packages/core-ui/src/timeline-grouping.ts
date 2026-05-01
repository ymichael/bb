import type { TimelineRow, ViewProjection } from "@bb/domain";
import {
  buildCollapsedTimelineRows,
  buildTimelineRows,
  type BuildTimelineRowsOptions,
} from "./thread-detail-rows.js";

export type GroupedTimelineRowsOptions = BuildTimelineRowsOptions;

export function buildGroupedTimelineRows(
  projection: ViewProjection,
  options?: GroupedTimelineRowsOptions,
): TimelineRow[] {
  return buildTimelineRows(projection, options);
}

export function buildCollapsedGroupedTimelineRows(
  projection: ViewProjection,
  options?: GroupedTimelineRowsOptions,
): TimelineRow[] {
  return buildCollapsedTimelineRows(projection, options);
}
