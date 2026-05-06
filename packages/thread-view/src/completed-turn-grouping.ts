import type {
  EventProjectionMessage,
  EventProjectionTurn,
} from "./event-projection-types.js";
import { getProjectionSummaryCount } from "./apply-turn-message-detail.js";
import { isTimelineUngroupableMessage } from "./timeline-message-helpers.js";

export interface CompletedTurnSummaryGroup {
  kind: "summary";
  startedAt: number;
  completedAt: number | null;
  segmentIndex: number | null;
  sourceMessages: EventProjectionMessage[];
  summaryCount: number;
}

export interface CompletedTurnUngroupedMessage {
  kind: "ungrouped-message";
  message: EventProjectionMessage;
}

export type CompletedTurnSummaryItem =
  | CompletedTurnSummaryGroup
  | CompletedTurnUngroupedMessage;

export interface CompletedTurnMessageGroups {
  summaryItems: CompletedTurnSummaryItem[];
  terminalMessages: EventProjectionMessage[];
  trailingMessages: EventProjectionMessage[];
}

interface CompletedTurnMessageSlices {
  summaryMessages: EventProjectionMessage[];
  terminalMessages: EventProjectionMessage[];
  trailingMessages: EventProjectionMessage[];
}

function splitCompletedTurnMessages(
  messages: readonly EventProjectionMessage[],
  terminalMessage: EventProjectionMessage | undefined,
): CompletedTurnMessageSlices {
  if (!terminalMessage) {
    return {
      summaryMessages: [...messages],
      terminalMessages: [],
      trailingMessages: [],
    };
  }

  const terminalIndex = messages.findIndex(
    (message) => message.id === terminalMessage.id,
  );
  if (terminalIndex === -1) {
    return {
      summaryMessages: [...messages],
      terminalMessages: [terminalMessage],
      trailingMessages: [],
    };
  }

  const terminalMessageAtIndex = messages[terminalIndex];
  if (!terminalMessageAtIndex) {
    throw new Error(
      `Cannot split completed turn messages at index ${terminalIndex}`,
    );
  }

  return {
    summaryMessages: messages.slice(0, terminalIndex),
    terminalMessages: [terminalMessageAtIndex],
    trailingMessages: messages.slice(terminalIndex + 1),
  };
}

function groupCompletedTurnSummaryMessages(
  turn: EventProjectionTurn,
  summaryMessages: EventProjectionMessage[],
): CompletedTurnSummaryItem[] {
  if (!summaryMessages.some(isTimelineUngroupableMessage)) {
    return [
      {
        kind: "summary",
        startedAt: turn.startedAt,
        completedAt: turn.completedAt,
        segmentIndex: null,
        sourceMessages: summaryMessages,
        summaryCount: turn.summaryCount,
      },
    ];
  }

  const items: CompletedTurnSummaryItem[] = [];
  let groupedMessages: EventProjectionMessage[] = [];
  let segmentIndex = 0;

  function flushGroupedMessages(): void {
    if (groupedMessages.length === 0) {
      return;
    }

    const sourceMessages = groupedMessages;
    items.push({
      kind: "summary",
      startedAt: turn.startedAt,
      completedAt: null,
      segmentIndex,
      sourceMessages,
      summaryCount: getProjectionSummaryCount(sourceMessages, undefined),
    });
    segmentIndex += 1;
    groupedMessages = [];
  }

  for (const message of summaryMessages) {
    if (isTimelineUngroupableMessage(message)) {
      flushGroupedMessages();
      items.push({
        kind: "ungrouped-message",
        message,
      });
      continue;
    }
    groupedMessages.push(message);
  }

  flushGroupedMessages();
  return items;
}

export function groupCompletedTurnMessages(
  turn: EventProjectionTurn,
): CompletedTurnMessageGroups {
  const messages = turn.messages ?? [];
  const { summaryMessages, terminalMessages, trailingMessages } =
    splitCompletedTurnMessages(messages, turn.terminalMessage);
  return {
    summaryItems: groupCompletedTurnSummaryMessages(turn, summaryMessages),
    terminalMessages,
    trailingMessages,
  };
}
