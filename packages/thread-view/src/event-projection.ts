import type { ActiveThinking } from "@bb/domain";
import type {
  BuildEventProjectionMessagesOptions,
  EventProjectionMessage,
} from "./event-projection-message.js";

export const eventProjectionTurnStatusValues = [
  "pending",
  "completed",
  "error",
  "interrupted",
] as const;
export type EventProjectionTurnStatus =
  (typeof eventProjectionTurnStatusValues)[number];

export const eventProjectionTurnMessageDetailValues = [
  "summary",
  "full",
] as const;
/**
 * Controls how eagerly completed turns include their message arrays.
 * Summary projections may still include messages when row ordering,
 * ungroupable messages, or post-terminal trailing messages need them.
 */
export type EventProjectionTurnMessageDetail =
  (typeof eventProjectionTurnMessageDetailValues)[number];

export interface EventProjectionState {
  /**
   * Root-projection-only ephemeral state that should not be modeled as a
   * timeline row. Nested child projections always expose `activeThinking` as
   * null because only the thread-level timeline owns live thinking state.
   */
  activeThinking: ActiveThinking | null;
}

export interface BuildEventProjectionOptions extends BuildEventProjectionMessagesOptions {
  turnMessageDetail: EventProjectionTurnMessageDetail;
}

export type EventProjectionEntry =
  | EventProjectionMessageEntry
  | EventProjectionTurnEntry;

export interface EventProjectionMessageEntry {
  kind: "projected-message";
  message: EventProjectionMessage;
}

export interface EventProjectionTurnEntry {
  kind: "turn";
  turn: EventProjectionTurn;
}

export interface EventProjectionTurn {
  turnId: string;
  threadId: string;
  sourceSeqStart: number;
  sourceSeqEnd: number;
  startedAt: number;
  createdAt: number;
  completedAt: number | null;
  status: EventProjectionTurnStatus;
  summaryCount: number;
  /** Present for completed turns; non-positive measured durations are clamped to 0. */
  durationMs?: number;
  terminalMessage?: EventProjectionMessage;
  messages?: EventProjectionMessage[];
}

export interface EventProjection {
  entries: EventProjectionEntry[];
  /** Projection-owned live state derived during the same event pass as entries. */
  state: EventProjectionState;
}
