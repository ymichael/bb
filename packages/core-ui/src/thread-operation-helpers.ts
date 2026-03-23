import { getMessageStartedAt } from "./format-helpers.js";
import type { UIMessage } from "@bb/domain";

type ThreadOperationAction = string;
type ThreadOperationStatus = string;

interface ClassifiedThreadOperation {
  operation: ThreadOperationAction;
  status: ThreadOperationStatus;
  operationId?: string;
}

export function isThreadOperation(
  message: UIMessage,
): message is Extract<UIMessage, { kind: "operation" }> {
  return message.kind === "operation" && message.opType === "operation";
}

function classifyThreadOperation(
  message: Extract<UIMessage, { kind: "operation" }>,
): ClassifiedThreadOperation | null {
  if (!message.threadOperation) {
    return null;
  }
  return {
    operation: message.threadOperation.operation,
    status: message.threadOperation.status,
    ...(message.threadOperation.operationId
      ? { operationId: message.threadOperation.operationId }
      : {}),
  };
}

function areThreadOperationIdsCompatible(
  leftOperationId: string | undefined,
  rightOperationId: string | undefined,
): boolean {
  if (!leftOperationId || !rightOperationId) {
    return true;
  }
  return leftOperationId === rightOperationId;
}

function isTerminalThreadOperationStatus(status: ThreadOperationStatus): boolean {
  switch (status) {
    case "completed":
    case "failed":
      return true;
    case "requested":
    case "queued":
    case "running":
    case "started":
    case "update":
      return false;
    default:
      // status is open_external; unknown values are intentionally treated as non-terminal.
      return false;
  }
}

export function mergeThreadOperationMessages(messages: UIMessage[]): UIMessage[] {
  const merged: UIMessage[] = [];

  for (let index = 0; index < messages.length; index += 1) {
    const initial = messages[index];
    if (!initial || !isThreadOperation(initial)) {
      if (initial) {
        merged.push(initial);
      }
      continue;
    }

    const initialClass = classifyThreadOperation(initial);
    if (!initialClass) {
      merged.push(initial);
      continue;
    }

    let cursor = index + 1;
    let promptMessage: Extract<UIMessage, { kind: "user" }> | null = null;
    const promptCandidate = messages[cursor];
    if (
      initialClass.operation === "squash_merge" &&
      initialClass.status === "requested" &&
      promptCandidate?.kind === "user"
    ) {
      promptMessage = promptCandidate;
      cursor += 1;
    }

    const lifecycleMessages: Array<Extract<UIMessage, { kind: "operation" }>> = [initial];
    let sawTerminalStatus = isTerminalThreadOperationStatus(initialClass.status);
    while (!sawTerminalStatus) {
      const lifecycleCandidate = messages[cursor];
      if (!lifecycleCandidate || !isThreadOperation(lifecycleCandidate)) {
        break;
      }
      const lifecycleClass = classifyThreadOperation(lifecycleCandidate);
      if (!lifecycleClass) {
        break;
      }
      if (
        lifecycleClass.operation !== initialClass.operation ||
        lifecycleClass.status === "requested" ||
        !areThreadOperationIdsCompatible(initialClass.operationId, lifecycleClass.operationId)
      ) {
        break;
      }
      lifecycleMessages.push(lifecycleCandidate);
      cursor += 1;
      if (isTerminalThreadOperationStatus(lifecycleClass.status)) {
        sawTerminalStatus = true;
      }
    }

    if (lifecycleMessages.length === 1) {
      merged.push(initial);
      continue;
    }

    const lifecycleCandidate = lifecycleMessages[lifecycleMessages.length - 1];
    if (!lifecycleCandidate) {
      merged.push(initial);
      continue;
    }

    const detailSections: string[] = [];
    const requestedDetail = initial.detail?.trim();
    const lifecycleDetail = lifecycleCandidate.detail?.trim();
    if (lifecycleDetail) {
      detailSections.push(lifecycleDetail);
    } else if (requestedDetail) {
      detailSections.push(requestedDetail);
    }

    const promptText = promptMessage?.text.trim();
    if (promptText) {
      detailSections.push(`Prompt:\n${promptText}`);
    }

    const sequence = promptMessage
      ? [initial, promptMessage, ...lifecycleMessages.slice(1)]
      : lifecycleMessages;

    merged.push({
      kind: "operation",
      id: `${initial.id}:operation:${lifecycleCandidate.id}`,
      threadId: initial.threadId,
      sourceSeqStart: Math.min(...sequence.map((message) => message.sourceSeqStart)),
      sourceSeqEnd: Math.max(...sequence.map((message) => message.sourceSeqEnd)),
      createdAt: Math.max(...sequence.map((message) => message.createdAt)),
      startedAt: Math.min(...sequence.map((message) => getMessageStartedAt(message))),
      turnId:
        lifecycleCandidate.turnId ??
        promptMessage?.turnId ??
        initial.turnId,
      opType: "operation",
      title: lifecycleCandidate.title,
      detail: detailSections.length > 0 ? detailSections.join("\n\n") : undefined,
      status: lifecycleCandidate.status,
      ...(lifecycleCandidate.threadOperation
        ? { threadOperation: lifecycleCandidate.threadOperation }
        : {}),
    });

    index = cursor - 1;
  }

  return merged;
}

export function isWorktreeSquashMergeOperation(
  message: UIMessage,
): message is Extract<UIMessage, { kind: "operation" }> {
  return message.kind === "operation" && message.opType === "worktree-squash-merge";
}

export function isWorktreeCommitOperation(
  message: UIMessage,
): message is Extract<UIMessage, { kind: "operation" }> {
  return message.kind === "operation" && message.opType === "worktree-commit";
}

function hasAdjacentThreadOperationOutcome(
  messages: UIMessage[],
  startIndex: number,
  direction: -1 | 1,
  operation: ThreadOperationAction,
  operationId?: string,
): boolean {
  for (
    let cursor = startIndex + direction;
    cursor >= 0 && cursor < messages.length;
    cursor += direction
  ) {
    const candidate = messages[cursor];
    if (!candidate) break;

    if (operation === "commit" && isWorktreeCommitOperation(candidate)) {
      return true;
    }
    if (operation === "squash_merge" && isWorktreeSquashMergeOperation(candidate)) {
      return true;
    }

    if (isThreadOperation(candidate)) {
      const candidateClass = classifyThreadOperation(candidate);
      if (!candidateClass) {
        return false;
      }
      if (candidateClass.operation === operation) {
        if (!areThreadOperationIdsCompatible(operationId, candidateClass.operationId)) {
          return false;
        }
        continue;
      }
      return false;
    }

    if (operation === "squash_merge" && isWorktreeCommitOperation(candidate)) {
      continue;
    }

    return false;
  }

  return false;
}

export function mergeThreadOperationOutcomeMessages(messages: UIMessage[]): UIMessage[] {
  const merged: UIMessage[] = [];

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (!message || !isThreadOperation(message)) {
      if (message) {
        merged.push(message);
      }
      continue;
    }

    const classified = classifyThreadOperation(message);
    if (!classified || classified.status === "failed") {
      merged.push(message);
      continue;
    }

    if (
      hasAdjacentThreadOperationOutcome(
        messages,
        index,
        1,
        classified.operation,
        classified.operationId,
      ) ||
      hasAdjacentThreadOperationOutcome(
        messages,
        index,
        -1,
        classified.operation,
        classified.operationId,
      )
    ) {
      continue;
    }

    merged.push(message);
  }

  return merged;
}

export function enrichWorktreeSquashMergeMessages(messages: UIMessage[]): UIMessage[] {
  return messages.map((message, index) => {
    if (!isWorktreeSquashMergeOperation(message)) {
      return message;
    }

    const previous = messages[index - 1];
    if (
      !previous ||
      !isWorktreeCommitOperation(previous) ||
      !previous.worktreeCommit ||
      !message.worktreeSquashMerge
    ) {
      return message;
    }

    if (
      message.worktreeSquashMerge?.status === "conflict" ||
      message.worktreeSquashMerge?.status === "noop" ||
      message.worktreeSquashMerge?.committed === false
    ) {
      return message;
    }

    const prepCommitMessage = previous.worktreeCommit.message?.trim();
    const prepCommitSha = previous.worktreeCommit.commitSha?.trim();
    if (!prepCommitMessage && !prepCommitSha) {
      return message;
    }

    const detailLines = [
      message.detail?.trim(),
      prepCommitMessage ? `Commit: ${prepCommitMessage}` : undefined,
      prepCommitSha ? `Hash: ${prepCommitSha}` : undefined,
    ].filter((value): value is string => Boolean(value));

    return {
      ...message,
      detail: detailLines.length > 0 ? detailLines.join("\n") : message.detail,
      worktreeSquashMerge: {
        ...message.worktreeSquashMerge,
        ...(prepCommitMessage ? { prepCommitMessage } : {}),
        ...(prepCommitSha ? { prepCommitSha } : {}),
      },
    };
  });
}
