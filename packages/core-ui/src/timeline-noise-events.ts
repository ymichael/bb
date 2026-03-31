import type { ThreadEventType } from "@bb/domain";

export const TIMELINE_NOISE_EVENT_TYPES: readonly ThreadEventType[] = [
  "thread/started",
  "thread/identity",
  "thread/tokenUsage/updated",
] as const;

const timelineNoiseEventTypeSet = new Set<ThreadEventType>(
  TIMELINE_NOISE_EVENT_TYPES,
);

export function isIgnoredNoiseType(eventType: ThreadEventType): boolean {
  return timelineNoiseEventTypeSet.has(eventType);
}
