import { threadEventSchema, type ThreadEvent } from "@bb/domain";
import { ThreadEventGrammar } from "../thread-event-grammar.js";
import type { ConformanceCheckResult } from "./types.js";

export const RECORDED_CONFORMANCE_CELLS = [
  "turn-tools",
  "steer",
  "stop-interrupt",
  "approval-allow",
  "approval-deny",
  "user-question",
  "resume",
  "fork",
] as const;

export type RecordedConformanceCell =
  (typeof RECORDED_CONFORMANCE_CELLS)[number];

export interface RecordedCellReplay {
  provider: string;
  cell: string;
  events: readonly ThreadEvent[];
  recordedEvents: readonly ThreadEvent[];
  stalls: readonly string[];
}

function result(
  id: string,
  title: string,
  detail: string | null,
): ConformanceCheckResult {
  return detail === null
    ? { id, title, status: "pass", detail: "" }
    : { id, title, status: "fail", detail };
}

export function countTurns(events: readonly ThreadEvent[]): {
  started: number;
  completed: number;
} {
  let started = 0;
  let completed = 0;
  for (const event of events) {
    if (event.type === "turn/started") started += 1;
    if (event.type === "turn/completed") completed += 1;
  }
  return { started, completed };
}

export function checkRecordedCellReplay(
  replay: RecordedCellReplay,
): ConformanceCheckResult[] {
  const prefix = `recorded/${replay.cell}`;
  const results: ConformanceCheckResult[] = [];

  const recordedTurns = countTurns(replay.recordedEvents);
  const liveTurns = countTurns(replay.events);

  results.push(
    result(
      `${prefix}/replays`,
      "the bridge answers every recorded runtime request and the replay needs no help",
      replay.stalls.length === 0 ? null : replay.stalls.join("; "),
    ),
  );

  results.push(
    result(
      `${prefix}/events-schema-valid`,
      "every assembled event is a valid ThreadEvent",
      (() => {
        for (const [index, event] of replay.events.entries()) {
          const parsed = threadEventSchema.safeParse(event);
          if (!parsed.success) {
            return `event ${index} (${event.type}) failed: ${parsed.error.issues[0]?.message ?? "invalid"}`;
          }
        }
        return null;
      })(),
    ),
  );

  results.push(
    result(
      `${prefix}/grammar`,
      "the event stream breaks no thread-event grammar rule",
      (() => {
        const grammar = new ThreadEventGrammar();
        for (const event of replay.events) {
          const verdict = grammar.observe(event);
          if (verdict.kind === "violation") {
            return `${verdict.rule} on ${event.type}: ${verdict.reason}`;
          }
        }
        return null;
      })(),
    ),
  );

  results.push(
    result(
      `${prefix}/turn-lifecycle`,
      "the replay opens and settles as many turns as the recording did",
      liveTurns.started === recordedTurns.started &&
        liveTurns.completed === recordedTurns.completed &&
        liveTurns.started === liveTurns.completed
        ? null
        : `replay ${liveTurns.started} started/${liveTurns.completed} completed, recording ${recordedTurns.started}/${recordedTurns.completed}`,
    ),
  );

  results.push(
    result(
      `${prefix}/not-empty`,
      "a recorded session that produced events still does",
      replay.recordedEvents.length === 0 || replay.events.length > 0
        ? null
        : `the recording assembled ${replay.recordedEvents.length} events, the replay none`,
    ),
  );

  return results;
}
