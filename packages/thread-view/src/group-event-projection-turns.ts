import type { ThreadEvent } from "@bb/domain";
import type {
  EventProjectionMessage,
  EventProjection,
  EventProjectionEntry,
  EventProjectionTurn,
  EventProjectionTurnStatus,
} from "./event-projection-types.js";
import { requireThreadEventScopeTurnId } from "@bb/domain";
import { assertNever } from "./assert-never.js";
import type { EventMeta } from "./event-decode.js";
import {
  assertTerminalMessageIncludedInMessages,
  getProjectionSummaryCount,
} from "./apply-turn-message-detail.js";
import { findLastTerminalTimelineMessage } from "./timeline-message-helpers.js";

export interface ThreadEventWithMeta {
  event: ThreadEvent;
  meta: EventMeta;
}

type TurnCompletedEvent = Extract<ThreadEvent, { type: "turn/completed" }>;
type TurnStartedEvent = Extract<ThreadEvent, { type: "turn/started" }>;

interface ProjectionTurnDraft {
  messages: EventProjectionMessage[];
  turn: EventProjectionTurn;
}

interface ProjectionTurnBoundsUpdate {
  createdAt: number;
  sourceSeqEnd: number;
  sourceSeqStart: number;
  threadId: string;
}

interface GroupEventProjectionTurnsArgs {
  events: ThreadEventWithMeta[];
  messages: EventProjectionMessage[];
}

interface TurnEntryDraft {
  kind: "turn";
  createdAt: number;
  sourceSeqStart: number;
  turnId: string;
}

interface StandaloneMessageEntryDraft {
  kind: "projected-message";
  createdAt: number;
  message: EventProjectionMessage;
  sourceSeqStart: number;
}

type ProjectionEntryDraft = TurnEntryDraft | StandaloneMessageEntryDraft;

export function getOrderedThreadEvents(
  events: readonly ThreadEventWithMeta[],
): ThreadEventWithMeta[] {
  let areEventsOrdered = true;
  for (let index = 1; index < events.length; index += 1) {
    if (events[index - 1].meta.seq > events[index].meta.seq) {
      areEventsOrdered = false;
      break;
    }
  }

  return areEventsOrdered
    ? Array.from(events)
    : Array.from(events).sort((a, b) => a.meta.seq - b.meta.seq);
}

function toEventProjectionTurnStatus(
  status: TurnCompletedEvent["status"],
): EventProjectionTurnStatus {
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
  draft.turn.status = toEventProjectionTurnStatus(event.status);
}

function addProjectionTurnMessage(
  draft: ProjectionTurnDraft,
  message: EventProjectionMessage,
): void {
  draft.messages.push(message);
  updateProjectionTurnBounds(draft, {
    threadId: message.threadId,
    sourceSeqStart: message.sourceSeqStart,
    sourceSeqEnd: message.sourceSeqEnd,
    createdAt: message.createdAt,
  });
}

function isExternalUserBoundaryForTurn(
  turnId: string,
  turn: EventProjectionTurn,
  message: EventProjectionMessage,
): boolean {
  if (message.kind !== "user" || message.initiator !== "user") {
    return false;
  }
  if (
    message.sourceSeqStart <= turn.sourceSeqStart ||
    message.sourceSeqStart >= turn.sourceSeqEnd
  ) {
    return false;
  }
  return message.scope.kind !== "turn" || message.scope.turnId !== turnId;
}

function applyExternalUserBoundaries(
  turnsById: Map<string, ProjectionTurnDraft>,
  messages: EventProjectionMessage[],
): void {
  for (const [turnId, draft] of turnsById) {
    const boundarySeqs = new Set<number>();
    for (const message of messages) {
      if (isExternalUserBoundaryForTurn(turnId, draft.turn, message)) {
        boundarySeqs.add(message.sourceSeqStart);
      }
    }
    if (boundarySeqs.size > 0) {
      draft.turn.externalUserBoundarySeqs = [...boundarySeqs].sort(
        (left, right) => left - right,
      );
    }
  }
}

function createEventProjectionEntry(
  draft: ProjectionEntryDraft,
  turnsById: Map<string, ProjectionTurnDraft>,
): EventProjectionEntry {
  if (draft.kind === "projected-message") {
    return {
      kind: "projected-message",
      message: draft.message,
    };
  }

  const turnDraft = turnsById.get(draft.turnId);
  if (!turnDraft) {
    throw new Error(
      `Cannot build timeline projection for missing turn ${draft.turnId}`,
    );
  }

  const terminalMessage = findLastTerminalTimelineMessage(turnDraft.messages);
  const turn: EventProjectionTurn = {
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

export function groupEventProjectionTurns(
  args: GroupEventProjectionTurnsArgs,
): EventProjection {
  const turnsById = new Map<string, ProjectionTurnDraft>();
  const clientRequestMetaById = new Map<string, EventMeta>();
  const entryDrafts: ProjectionEntryDraft[] = [];

  for (const { event, meta } of args.events) {
    if (event.type === "client/turn/requested") {
      clientRequestMetaById.set(event.requestId, meta);
    }
  }

  for (const { event, meta } of args.events) {
    if (event.type === "turn/started") {
      const turnId = requireThreadEventScopeTurnId({
        type: event.type,
        scope: event.scope,
      });
      if (turnsById.has(turnId)) {
        continue;
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
      continue;
    }

    if (event.type === "turn/input/accepted") {
      const turnId = requireThreadEventScopeTurnId({
        type: event.type,
        scope: event.scope,
      });
      const existing = turnsById.get(turnId);
      if (!existing) {
        throw new Error(
          `Timeline projection found turn/input/accepted without turn/started for ${turnId}`,
        );
      }
      const clientRequestMeta = clientRequestMetaById.get(
        event.clientRequestId,
      );
      if (clientRequestMeta) {
        updateProjectionTurnBounds(existing, {
          threadId: event.threadId,
          sourceSeqStart: clientRequestMeta.seq,
          sourceSeqEnd: clientRequestMeta.seq,
          createdAt: clientRequestMeta.createdAt,
        });
      }
    }
  }

  for (const message of args.messages) {
    if (message.scope.kind === "thread") {
      entryDrafts.push({
        kind: "projected-message",
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

  applyExternalUserBoundaries(turnsById, args.messages);

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
    state: {
      activeThinking: null,
      activeWorkflows: [],
      activeBackgroundCommands: [],
    },
    entries: orderedEntryDrafts.map((entryDraft) =>
      createEventProjectionEntry(entryDraft, turnsById),
    ),
  };
}
