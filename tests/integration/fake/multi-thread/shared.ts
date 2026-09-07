import type { ThreadEventRow } from "@bb/domain";
import { expect } from "vitest";
import { scaleTimeoutMs } from "../../helpers/time.js";

export const DEFAULT_TIMEOUT_MS = scaleTimeoutMs(10_000);
export const TURN_TIMEOUT_MS = scaleTimeoutMs(15_000);
export const ACTIVE_TIMEOUT_MS = scaleTimeoutMs(5_000);
export const CONCURRENT_DELAY_TEXT = "delay:800";

export function countTurnEvents(
  events: ThreadEventRow[],
  type: "turn/completed" | "turn/started",
): number {
  return events.filter((event) => event.type === type).length;
}

export function assertEventsBelongToThread(
  events: ThreadEventRow[],
  threadId: string,
): void {
  expect(events.length).toBeGreaterThan(0);
  expect(events.every((event) => event.threadId === threadId)).toBe(true);
}
