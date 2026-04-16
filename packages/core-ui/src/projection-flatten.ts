import type {
  ViewMessage,
  ViewProjection,
  ViewTimelineEntry,
} from "@bb/domain";

function getProjectionEntryMessages(entry: ViewTimelineEntry): readonly ViewMessage[] {
  if (entry.kind === "message") {
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

export function flattenProjectionMessages(
  projection: ViewProjection,
): ViewMessage[] {
  const messages: ViewMessage[] = [];
  for (const entry of projection.entries) {
    messages.push(...getProjectionEntryMessages(entry));
  }
  return messages;
}

export function flattenViewMessagesDeep(
  rootMessages: readonly ViewMessage[],
): ViewMessage[] {
  const messages: ViewMessage[] = [];
  for (const message of rootMessages) {
    messages.push(message);
    if (message.kind === "delegation") {
      messages.push(...flattenProjectionMessagesDeep(message.childProjection));
    }
  }
  return messages;
}

export function flattenProjectionMessagesDeep(
  projection: ViewProjection,
): ViewMessage[] {
  return flattenViewMessagesDeep(flattenProjectionMessages(projection));
}
