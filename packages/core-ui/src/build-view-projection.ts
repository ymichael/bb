import type {
  ThreadEvent,
  ViewMessage,
  ViewProjection,
  ViewTimelineEntry,
  ViewTurn,
  ViewTurnStatus,
} from "@bb/domain";
import { requireThreadEventScopeTurnId } from "@bb/domain";
import { assertNever } from "./assert-never.js";
import type { EventMeta } from "./event-decode.js";
import {
  assertTerminalMessageIncludedInMessages,
  findProjectionTerminalMessage,
  getProjectionSummaryCount,
} from "./apply-turn-message-detail.js";

/** A typed thread event paired with its row metadata. */
export interface ThreadEventWithMeta {
  event: ThreadEvent;
  meta: EventMeta;
}

type TurnCompletedEvent = Extract<ThreadEvent, { type: "turn/completed" }>;
type TurnStartedEvent = Extract<ThreadEvent, { type: "turn/started" }>;

interface ProjectionTurnDraft {
  messages: ViewMessage[];
  turn: ViewTurn;
}

interface ProjectionTurnBoundsUpdate {
  createdAt: number;
  sourceSeqEnd: number;
  sourceSeqStart: number;
  threadId: string;
}

interface BuildViewProjectionArgs {
  events: ThreadEventWithMeta[];
  messages: ViewMessage[];
}

interface TurnEntryDraft {
  kind: "turn";
  createdAt: number;
  sourceSeqStart: number;
  turnId: string;
}

interface StandaloneMessageEntryDraft {
  kind: "message";
  createdAt: number;
  message: ViewMessage;
  sourceSeqStart: number;
}

type ProjectionEntryDraft = TurnEntryDraft | StandaloneMessageEntryDraft;

export function getOrderedThreadEvents(
  events: ThreadEventWithMeta[],
): ThreadEventWithMeta[] {
  let areEventsOrdered = true;
  for (let index = 1; index < events.length; index += 1) {
    if (events[index - 1].meta.seq > events[index].meta.seq) {
      areEventsOrdered = false;
      break;
    }
  }

  return areEventsOrdered
    ? events
    : [...events].sort((a, b) => a.meta.seq - b.meta.seq);
}

function toViewTurnStatus(
  status: TurnCompletedEvent["status"],
): ViewTurnStatus {
  switch (status) {
    case "completed":
      return "completed";
    case "failed":
      return "error";
    case "interrupted":
      return "interrupted";
    default:
      return assertNever(status);
  }
}

function getTurnDurationMs(startedAt: number, completedAt: number): number {
  return Math.max(0, completedAt - startedAt);
}

function createProjectionTurn(
  event: TurnStartedEvent,
  meta: EventMeta,
): ProjectionTurnDraft {
  const turnId = requireThreadEventScopeTurnId({
    type: event.type,
    scope: event.scope,
  });
  return {
    messages: [],
    turn: {
      turnId,
      threadId: event.threadId,
      sourceSeqStart: meta.seq,
      sourceSeqEnd: meta.seq,
      startedAt: meta.createdAt,
      createdAt: meta.createdAt,
      completedAt: null,
      status: "pending",
      summaryCount: 0,
    },
  };
}

function updateProjectionTurnBounds(
  draft: ProjectionTurnDraft,
  update: ProjectionTurnBoundsUpdate,
): void {
  draft.turn.threadId = update.threadId;
  draft.turn.sourceSeqStart = Math.min(
    draft.turn.sourceSeqStart,
    update.sourceSeqStart,
  );
  draft.turn.sourceSeqEnd = Math.max(
    draft.turn.sourceSeqEnd,
    update.sourceSeqEnd,
  );
  draft.turn.createdAt = Math.max(draft.turn.createdAt, update.createdAt);
}

function updateProjectionTurnCompletion(
  draft: ProjectionTurnDraft,
  event: TurnCompletedEvent,
  meta: EventMeta,
): void {
  updateProjectionTurnBounds(draft, {
    threadId: event.threadId,
    sourceSeqStart: meta.seq,
    sourceSeqEnd: meta.seq,
    createdAt: meta.createdAt,
  });
  draft.turn.completedAt = meta.createdAt;
  draft.turn.status = toViewTurnStatus(event.status);
  draft.turn.durationMs = getTurnDurationMs(
    draft.turn.startedAt,
    meta.createdAt,
  );
}

function addProjectionTurnMessage(
  draft: ProjectionTurnDraft,
  message: ViewMessage,
): void {
  draft.messages.push(message);
  updateProjectionTurnBounds(draft, {
    threadId: message.threadId,
    sourceSeqStart: message.sourceSeqStart,
    sourceSeqEnd: message.sourceSeqEnd,
    createdAt: message.createdAt,
  });
}

function createViewTimelineEntry(
  draft: ProjectionEntryDraft,
  turnsById: Map<string, ProjectionTurnDraft>,
): ViewTimelineEntry {
  if (draft.kind === "message") {
    return {
      kind: "message",
      message: draft.message,
    };
  }

  const turnDraft = turnsById.get(draft.turnId);
  if (!turnDraft) {
    throw new Error(
      `Cannot build timeline projection for missing turn ${draft.turnId}`,
    );
  }

  const terminalMessage = findProjectionTerminalMessage(turnDraft.messages);
  const turn: ViewTurn = {
    ...turnDraft.turn,
    summaryCount: getProjectionSummaryCount(
      turnDraft.messages,
      terminalMessage,
    ),
    messages: turnDraft.messages,
  };
  if (terminalMessage) {
    turn.terminalMessage = terminalMessage;
  }
  assertTerminalMessageIncludedInMessages(turn);
  return {
    kind: "turn",
    turn,
  };
}

export function buildViewProjection(
  args: BuildViewProjectionArgs,
): ViewProjection {
  const turnsById = new Map<string, ProjectionTurnDraft>();
  const entryDrafts: ProjectionEntryDraft[] = [];

  for (const { event, meta } of args.events) {
    if (event.type === "turn/started") {
      const turnId = requireThreadEventScopeTurnId({
        type: event.type,
        scope: event.scope,
      });
      const existing = turnsById.get(turnId);
      if (existing) {
        throw new Error(
          `Timeline projection found duplicate turn/started for ${turnId}`,
        );
      }
      turnsById.set(turnId, createProjectionTurn(event, meta));
      entryDrafts.push({
        kind: "turn",
        turnId,
        sourceSeqStart: meta.seq,
        createdAt: meta.createdAt,
      });
      continue;
    }

    if (event.type === "turn/completed") {
      const turnId = requireThreadEventScopeTurnId({
        type: event.type,
        scope: event.scope,
      });
      const existing = turnsById.get(turnId);
      if (!existing) {
        throw new Error(
          `Timeline projection found turn/completed without turn/started for ${turnId}`,
        );
      }
      updateProjectionTurnCompletion(existing, event, meta);
    }
  }

  for (const message of args.messages) {
    if (message.scope.kind === "thread") {
      entryDrafts.push({
        kind: "message",
        message,
        sourceSeqStart: message.sourceSeqStart,
        createdAt: message.createdAt,
      });
      continue;
    }

    const turnId = message.scope.turnId;
    const turnDraft = turnsById.get(turnId);
    if (!turnDraft) {
      throw new Error(
        `Timeline projection found message ${message.id} for turn ${turnId} without turn/started`,
      );
    }

    addProjectionTurnMessage(turnDraft, message);
  }

  const orderedEntryDrafts = [...entryDrafts].sort((left, right) => {
    if (left.sourceSeqStart !== right.sourceSeqStart) {
      return left.sourceSeqStart - right.sourceSeqStart;
    }
    if (left.createdAt !== right.createdAt) {
      return left.createdAt - right.createdAt;
    }
    return 0;
  });

  return {
    entries: orderedEntryDrafts.map((entryDraft) =>
      createViewTimelineEntry(entryDraft, turnsById),
    ),
  };
}
