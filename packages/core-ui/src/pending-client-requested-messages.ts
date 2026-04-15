import type { ViewMessage } from "@bb/domain";

type ProjectedUserMessage = Extract<ViewMessage, { kind: "user" }>;

export interface PendingClientRequestedMessageQueue {
  messagesByTurnIdAndSignature: Map<string, Map<string, ProjectedUserMessage[]>>;
  signatureCounts: Map<string, number>;
}

interface PendingClientRequestedQueueKeyArgs {
  signature: string;
  turnId?: string;
}

interface AppendPendingClientRequestedMessageArgs
  extends PendingClientRequestedQueueKeyArgs {
  message: ProjectedUserMessage;
}

interface RecordPendingClientRequestedMessageArgs
  extends PendingClientRequestedQueueKeyArgs {
  message?: ProjectedUserMessage;
}

interface AttachPendingClientRequestedMessagesToTurnArgs {
  threadId: string;
  turnId: string;
}

interface PendingClientRequestedSignatureArgs {
  signature: string;
}

interface PendingClientRequestedQueueLocation {
  signature: string;
  signatureMap: Map<string, ProjectedUserMessage[]>;
  turnKey: string;
}

export interface PendingClientRequestedMessageMatch {
  message: ProjectedUserMessage;
  turnId?: string;
}

const TURNLESS_PENDING_CLIENT_REQUESTED_KEY = "";

export function createPendingClientRequestedMessageQueue(): PendingClientRequestedMessageQueue {
  return {
    messagesByTurnIdAndSignature: new Map(),
    signatureCounts: new Map(),
  };
}

function getPendingClientRequestedSignatureCount(
  queue: PendingClientRequestedMessageQueue,
  signature: string,
): number {
  return queue.signatureCounts.get(signature) ?? 0;
}

function incrementPendingClientRequestedSignatureCount(
  queue: PendingClientRequestedMessageQueue,
  signature: string,
): void {
  queue.signatureCounts.set(
    signature,
    getPendingClientRequestedSignatureCount(queue, signature) + 1,
  );
}

function pendingClientRequestedTurnKey(turnId: string | undefined): string {
  return turnId ?? TURNLESS_PENDING_CLIENT_REQUESTED_KEY;
}

function getPendingClientRequestedSignatureMap(
  queue: PendingClientRequestedMessageQueue,
  turnKey: string,
): Map<string, ProjectedUserMessage[]> {
  const existing = queue.messagesByTurnIdAndSignature.get(turnKey);
  if (existing) {
    return existing;
  }
  const signatureMap = new Map<string, ProjectedUserMessage[]>();
  queue.messagesByTurnIdAndSignature.set(turnKey, signatureMap);
  return signatureMap;
}

export function appendPendingClientRequestedMessage(
  queue: PendingClientRequestedMessageQueue,
  args: AppendPendingClientRequestedMessageArgs,
): void {
  const signatureMap = getPendingClientRequestedSignatureMap(
    queue,
    pendingClientRequestedTurnKey(args.turnId),
  );
  signatureMap.set(
    args.signature,
    [...(signatureMap.get(args.signature) ?? []), args.message],
  );
}

export function recordPendingClientRequestedMessage(
  queue: PendingClientRequestedMessageQueue,
  args: RecordPendingClientRequestedMessageArgs,
): void {
  incrementPendingClientRequestedSignatureCount(queue, args.signature);
  if (!args.message) {
    return;
  }
  appendPendingClientRequestedMessage(queue, {
    message: args.message,
    signature: args.signature,
    turnId: args.turnId,
  });
}

export function hasPendingClientRequestedSignature(
  queue: PendingClientRequestedMessageQueue,
  args: PendingClientRequestedSignatureArgs,
): boolean {
  return getPendingClientRequestedSignatureCount(queue, args.signature) > 0;
}

export function consumePendingClientRequestedSignature(
  queue: PendingClientRequestedMessageQueue,
  args: PendingClientRequestedSignatureArgs,
): boolean {
  const count = getPendingClientRequestedSignatureCount(queue, args.signature);
  if (count <= 0) {
    return false;
  }
  if (count === 1) {
    queue.signatureCounts.delete(args.signature);
    return true;
  }
  queue.signatureCounts.set(args.signature, count - 1);
  return true;
}

export function clearPendingClientRequestedSignatureCounts(
  queue: PendingClientRequestedMessageQueue,
): void {
  queue.signatureCounts.clear();
}

export function attachPendingClientRequestedMessagesToTurn(
  queue: PendingClientRequestedMessageQueue,
  args: AttachPendingClientRequestedMessagesToTurnArgs,
): void {
  const turnlessSignatureMap = queue.messagesByTurnIdAndSignature.get(
    TURNLESS_PENDING_CLIENT_REQUESTED_KEY,
  );
  if (!turnlessSignatureMap) {
    return;
  }

  let turnSignatureMap: Map<string, ProjectedUserMessage[]> | undefined;
  for (const [signature, messages] of turnlessSignatureMap) {
    const movedMessages = messages
      .filter((message) => message.threadId === args.threadId)
      .map((message) => ({ ...message, turnId: args.turnId }));
    if (movedMessages.length === 0) {
      continue;
    }

    const remainingMessages = messages.filter(
      (message) => message.threadId !== args.threadId,
    );
    if (remainingMessages.length === 0) {
      turnlessSignatureMap.delete(signature);
    } else {
      turnlessSignatureMap.set(signature, remainingMessages);
    }

    turnSignatureMap ??= getPendingClientRequestedSignatureMap(
      queue,
      pendingClientRequestedTurnKey(args.turnId),
    );
    turnSignatureMap.set(signature, [
      ...(turnSignatureMap.get(signature) ?? []),
      ...movedMessages,
    ]);
  }

  if (turnlessSignatureMap.size === 0) {
    queue.messagesByTurnIdAndSignature.delete(
      TURNLESS_PENDING_CLIENT_REQUESTED_KEY,
    );
  }
}

function findPendingClientRequestedQueueLocation(
  queue: PendingClientRequestedMessageQueue,
  args: PendingClientRequestedQueueKeyArgs,
): PendingClientRequestedQueueLocation | undefined {
  const exactTurnKey = pendingClientRequestedTurnKey(args.turnId);
  const exactSignatureMap = queue.messagesByTurnIdAndSignature.get(exactTurnKey);
  const exactMessages = exactSignatureMap?.get(args.signature);
  if (exactSignatureMap && exactMessages && exactMessages.length > 0) {
    return {
      signature: args.signature,
      signatureMap: exactSignatureMap,
      turnKey: exactTurnKey,
    };
  }
  if (!args.turnId) {
    return undefined;
  }
  // Provider acks are turn-scoped; only fall back to turnless optimistic requests.
  const turnlessSignatureMap = queue.messagesByTurnIdAndSignature.get(
    TURNLESS_PENDING_CLIENT_REQUESTED_KEY,
  );
  const turnlessMessages = turnlessSignatureMap?.get(args.signature);
  if (turnlessSignatureMap && turnlessMessages && turnlessMessages.length > 0) {
    return {
      signature: args.signature,
      signatureMap: turnlessSignatureMap,
      turnKey: TURNLESS_PENDING_CLIENT_REQUESTED_KEY,
    };
  }
  return undefined;
}

export function shiftPendingClientRequestedMessage(
  queue: PendingClientRequestedMessageQueue,
  args: PendingClientRequestedQueueKeyArgs,
): PendingClientRequestedMessageMatch | undefined {
  const location = findPendingClientRequestedQueueLocation(queue, args);
  if (!location) {
    return undefined;
  }
  const messages = location.signatureMap.get(location.signature);
  if (!messages || messages.length === 0) {
    return undefined;
  }
  const [message, ...remainingMessages] = messages;
  if (remainingMessages.length === 0) {
    location.signatureMap.delete(location.signature);
    if (location.signatureMap.size === 0) {
      queue.messagesByTurnIdAndSignature.delete(location.turnKey);
    }
  } else {
    location.signatureMap.set(location.signature, remainingMessages);
  }
  return {
    message,
    ...(location.turnKey === TURNLESS_PENDING_CLIENT_REQUESTED_KEY
      ? {}
      : { turnId: location.turnKey }),
  };
}

export function materializePendingClientRequestedMessages(
  queue: PendingClientRequestedMessageQueue,
  afterSourceSeq: number,
): ProjectedUserMessage[] {
  const messages: ProjectedUserMessage[] = [];
  for (const signatureMap of queue.messagesByTurnIdAndSignature.values()) {
    for (const pendingMessages of signatureMap.values()) {
      messages.push(...pendingMessages);
    }
  }
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
      // Pending client-requested rows are a compatibility path for historical or
      // provider data without a durable user-message ack. Keep them turnless so
      // they render after the durable timeline instead of being attached inline.
      const { turnId, ...messageWithoutTurnId } = message;
      void turnId;
      return {
        ...messageWithoutTurnId,
        sourceSeqStart: sourceSeq,
        sourceSeqEnd: sourceSeq,
      };
    });
}
