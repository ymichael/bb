import type {
  ViewMessage,
  ViewProjection,
  ViewTurn,
  ViewTurnMessageDetail,
} from "@bb/domain";
import {
  findLastTerminalTimelineMessage,
  isTimelineUngroupableMessage,
  toTimelineVisibleMessages,
} from "./timeline-message-helpers.js";

export function findProjectionTerminalMessage(
  messages: ViewMessage[],
): ViewMessage | undefined {
  return findLastTerminalTimelineMessage(messages);
}

function getProjectionMessageSummaryCount(message: ViewMessage): number {
  if (message.kind === "tool-exploring") {
    return Math.max(1, message.calls.length);
  }
  if (message.kind === "file-edit") {
    return Math.max(1, message.changes.length);
  }
  return 1;
}

export function getProjectionSummaryCount(
  messages: ViewMessage[],
  terminalMessage: ViewMessage | undefined,
): number {
  return getVisibleProjectionSummaryCount(
    toTimelineVisibleMessages(messages),
    terminalMessage,
  );
}

function getVisibleProjectionSummaryCount(
  visibleMessages: ViewMessage[],
  terminalMessage: ViewMessage | undefined,
): number {
  let count = 0;
  for (const message of visibleMessages) {
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
  visibleMessages: ViewMessage[],
  terminalMessage: ViewMessage | undefined,
): boolean {
  let foundTerminalMessage = false;
  for (const message of visibleMessages) {
    if (terminalMessage && message.id === terminalMessage.id) {
      foundTerminalMessage = true;
      continue;
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

export function assertTerminalMessageIncludedInMessages(turn: ViewTurn): void {
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

function withChildProjectionDetail(message: ViewMessage): ViewMessage {
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
  turn: ViewTurn,
  turnMessageDetail: ViewTurnMessageDetail,
): ViewTurn {
  const messages = (turn.messages ?? []).map((message) =>
    withChildProjectionDetail(message)
  );
  const terminalMessage = findProjectionTerminalMessage(messages);
  const visibleMessages = toTimelineVisibleMessages(messages);
  const summaryCount = getVisibleProjectionSummaryCount(
    visibleMessages,
    terminalMessage,
  );
  const includeMessages =
    turn.status === "pending" ||
    turnMessageDetail === "full" ||
    shouldIncludeSummaryTurnMessages(visibleMessages, terminalMessage);

  const detailedTurn: ViewTurn = {
    ...turn,
    summaryCount,
  };
  delete detailedTurn.terminalMessage;
  delete detailedTurn.messages;
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
  projection: ViewProjection,
  turnMessageDetail: ViewTurnMessageDetail,
): ViewProjection {
  return {
    entries: projection.entries.map((entry) => {
      if (entry.kind === "message") {
        return {
          kind: "message",
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
