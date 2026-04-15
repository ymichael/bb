import type { ViewMessage } from "@bb/domain";

type ProjectedUserMessage = Extract<ViewMessage, { kind: "user" }>;

export interface PendingClientRequestedMessageQueue {
  messagesByClientRequestSequence: Map<number, ProjectedUserMessage | null>;
}

interface RecordPendingClientRequestedMessageArgs {
  clientRequestSequence: number;
  message?: ProjectedUserMessage;
}

interface ShiftPendingClientRequestedMessageArgs {
  clientRequestSequence: number;
}

interface PendingClientRequestedMessageMatch {
  message?: ProjectedUserMessage;
}

export function createPendingClientRequestedMessageQueue(): PendingClientRequestedMessageQueue {
  return {
    messagesByClientRequestSequence: new Map(),
  };
}

export function recordPendingClientRequestedMessage(
  queue: PendingClientRequestedMessageQueue,
  args: RecordPendingClientRequestedMessageArgs,
): void {
  queue.messagesByClientRequestSequence.set(
    args.clientRequestSequence,
    args.message ?? null,
  );
}

export function shiftPendingClientRequestedMessage(
  queue: PendingClientRequestedMessageQueue,
  args: ShiftPendingClientRequestedMessageArgs,
): PendingClientRequestedMessageMatch | undefined {
  if (!queue.messagesByClientRequestSequence.has(args.clientRequestSequence)) {
    return undefined;
  }
  const message = queue.messagesByClientRequestSequence.get(
    args.clientRequestSequence,
  );
  queue.messagesByClientRequestSequence.delete(args.clientRequestSequence);
  return message ? { message } : {};
}

export function materializePendingClientRequestedMessages(
  queue: PendingClientRequestedMessageQueue,
  afterSourceSeq: number,
): ProjectedUserMessage[] {
  const messages = [...queue.messagesByClientRequestSequence.values()]
    .filter((message): message is ProjectedUserMessage => message !== null);
  return messages
    .sort((left, right) => {
      if (left.sourceSeqStart !== right.sourceSeqStart) {
        return left.sourceSeqStart - right.sourceSeqStart;
      }
      if (left.createdAt !== right.createdAt) {
        return left.createdAt - right.createdAt;
      }
      return 0;
    })
    .map((message, index) => {
      const sourceSeq = afterSourceSeq + index + 1;
      return {
        ...message,
        sourceSeqStart: sourceSeq,
        sourceSeqEnd: sourceSeq,
      };
    });
}
