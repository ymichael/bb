import { getMessageStartedAt } from "./format-helpers.js";
import type { ViewMessage } from "@bb/domain";

type ThreadOperationAction = string;
type ThreadOperationStatus = string;

interface ClassifiedThreadOperation {
  operation: ThreadOperationAction;
  status: ThreadOperationStatus;
  operationId?: string;
}

export function isThreadOperation(
  message: ViewMessage,
): message is Extract<ViewMessage, { kind: "operation" }> {
  return message.kind === "operation" && message.opType === "operation";
}

function classifyThreadOperation(
  message: Extract<ViewMessage, { kind: "operation" }>,
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

export function mergeThreadOperationMessages(messages: ViewMessage[]): ViewMessage[] {
  const merged: ViewMessage[] = [];

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
    let promptMessage: Extract<ViewMessage, { kind: "user" }> | null = null;
    const promptCandidate = messages[cursor];
    if (
      initialClass.operation === "squash_merge" &&
      initialClass.status === "requested" &&
      promptCandidate?.kind === "user"
    ) {
      promptMessage = promptCandidate;
      cursor += 1;
    }

    const lifecycleMessages: Array<Extract<ViewMessage, { kind: "operation" }>> = [initial];
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
