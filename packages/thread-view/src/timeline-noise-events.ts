import type { ThreadEventType } from "@bb/domain";

export const THREAD_TIMELINE_EXCLUDED_EVENT_TYPES = [
  "thread/started",
  "thread/identity",
  "thread/contextWindowUsage/updated",
  "thread/tokenUsage/updated",
  "turn/diff/updated",
] as const satisfies readonly ThreadEventType[];
