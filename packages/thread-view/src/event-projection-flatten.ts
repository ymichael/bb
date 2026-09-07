import type {
  EventProjectionMessage,
  EventProjection,
  EventProjectionEntry,
} from "./event-projection-types.js";

export function getProjectionEntryMessages(
  entry: EventProjectionEntry,
): readonly EventProjectionMessage[] {
  if (entry.kind === "projected-message") {
    return [entry.message];
  }
  if (entry.turn.messages) {
    return entry.turn.messages;
  }
  if (entry.turn.terminalMessage) {
    return [entry.turn.terminalMessage];
  }
  return [];
}

function flattenEventProjectionMessages(
  projection: EventProjection,
): EventProjectionMessage[] {
  const messages: EventProjectionMessage[] = [];
  for (const entry of projection.entries) {
    messages.push(...getProjectionEntryMessages(entry));
  }
  return messages;
}

function flattenEventProjectionMessageListDeep(
  rootMessages: readonly EventProjectionMessage[],
): EventProjectionMessage[] {
  const messages: EventProjectionMessage[] = [];
  for (const message of rootMessages) {
    messages.push(message);
    if (message.kind === "delegation") {
      messages.push(
        ...flattenEventProjectionMessageListDeep(
          flattenEventProjectionMessages(message.childProjection),
        ),
      );
    }
  }
  return messages;
}

export function flattenEventProjectionMessagesDeep(
  projection: EventProjection,
): EventProjectionMessage[] {
  return flattenEventProjectionMessageListDeep(
    flattenEventProjectionMessages(projection),
  );
}
