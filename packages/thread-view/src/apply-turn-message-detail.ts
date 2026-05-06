import type {
  EventProjectionMessage,
  EventProjection,
  EventProjectionTurn,
  EventProjectionTurnMessageDetail,
} from "./event-projection-types.js";
import {
  findLastTerminalTimelineMessage,
  isTimelineTerminalMessage,
  isTimelineUngroupableMessage,
} from "./timeline-message-helpers.js";

export function findProjectionTerminalMessage(
  messages: EventProjectionMessage[],
): EventProjectionMessage | undefined {
  return findLastTerminalTimelineMessage(messages);
}

function getProjectionMessageSummaryCount(
  message: EventProjectionMessage,
): number {
  if (message.kind === "file-edit") {
    return Math.max(1, message.changes.length);
  }
  return 1;
}

export function getProjectionSummaryCount(
  messages: EventProjectionMessage[],
  terminalMessage: EventProjectionMessage | undefined,
): number {
  let count = 0;
  for (const message of messages) {
    if (terminalMessage && message.id === terminalMessage.id) {
      break;
    }
    if (isTimelineUngroupableMessage(message)) {
      continue;
    }
    count += getProjectionMessageSummaryCount(message);
  }
  return count;
}

function shouldIncludeSummaryTurnMessages(
  messages: EventProjectionMessage[],
  terminalMessage: EventProjectionMessage | undefined,
): boolean {
  let foundTerminalMessage = false;
  for (const message of messages) {
    if (terminalMessage && message.id === terminalMessage.id) {
      foundTerminalMessage = true;
      continue;
    }
    if (terminalMessage && isTimelineTerminalMessage(message)) {
      return true;
    }
    if (isTimelineUngroupableMessage(message)) {
      return true;
    }
    if (terminalMessage && foundTerminalMessage) {
      return true;
    }
  }
  return false;
}

export function assertTerminalMessageIncludedInMessages(
  turn: EventProjectionTurn,
): void {
  const messages = turn.messages;
  const terminalMessage = turn.terminalMessage;
  if (!messages || !terminalMessage) {
    return;
  }
  if (messages.some((message) => message.id === terminalMessage.id)) {
    return;
  }
  throw new Error(
    `Timeline projection turn ${turn.turnId} has terminal message ${terminalMessage.id} outside its messages array`,
  );
}

function withChildProjectionDetail(
  message: EventProjectionMessage,
): EventProjectionMessage {
  if (message.kind !== "delegation") {
    return message;
  }
  return {
    ...message,
    childProjection: applyProjectionTurnMessageDetail(
      message.childProjection,
      "full",
    ),
  };
}

function applyTurnMessageDetail(
  turn: EventProjectionTurn,
  turnMessageDetail: EventProjectionTurnMessageDetail,
): EventProjectionTurn {
  const messages = (turn.messages ?? []).map((message) =>
    withChildProjectionDetail(message),
  );
  const terminalMessage = findProjectionTerminalMessage(messages);
  const summaryCount = getProjectionSummaryCount(messages, terminalMessage);
  const includeMessages =
    turn.status === "pending" ||
    turnMessageDetail === "full" ||
    shouldIncludeSummaryTurnMessages(messages, terminalMessage);

  const detailedTurn: EventProjectionTurn = {
    turnId: turn.turnId,
    threadId: turn.threadId,
    sourceSeqStart: turn.sourceSeqStart,
    sourceSeqEnd: turn.sourceSeqEnd,
    startedAt: turn.startedAt,
    createdAt: turn.createdAt,
    completedAt: turn.completedAt,
    status: turn.status,
    summaryCount,
  };
  if (terminalMessage) {
    detailedTurn.terminalMessage = terminalMessage;
  }
  if (includeMessages) {
    detailedTurn.messages = messages;
  }
  assertTerminalMessageIncludedInMessages(detailedTurn);
  return detailedTurn;
}

export function applyProjectionTurnMessageDetail(
  projection: EventProjection,
  turnMessageDetail: EventProjectionTurnMessageDetail,
): EventProjection {
  return {
    state: projection.state,
    entries: projection.entries.map((entry) => {
      if (entry.kind === "projected-message") {
        return {
          kind: "projected-message",
          message: withChildProjectionDetail(entry.message),
        };
      }
      return {
        kind: "turn",
        turn: applyTurnMessageDetail(entry.turn, turnMessageDetail),
      };
    }),
  };
}
