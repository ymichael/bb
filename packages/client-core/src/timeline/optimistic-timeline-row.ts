export const OPTIMISTIC_TIMELINE_ROW_ID_PREFIX = "optimistic-user-";

export function isOptimisticTimelineRowId(id: string): boolean {
  return id.startsWith(OPTIMISTIC_TIMELINE_ROW_ID_PREFIX);
}
