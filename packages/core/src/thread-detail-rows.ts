import { assertNever } from "./assert-never.js";
import type {
  UIMessage,
  UIPrimaryCheckoutAction,
  UIPrimaryCheckoutPhase,
  UIProvisioningMetadata,
  UIProvisioningSetupMetadata,
  UIProvisioningTranscriptEntry,
  UIThreadOperationIntentAction,
  UIThreadOperationIntentPhase,
} from "./ui-message.js";

type CollapsibleTurnMessage = UIMessage;

export interface ThreadDetailMessageRow {
  kind: "message";
  id: string;
  message: UIMessage;
}

export interface ThreadDetailToolGroupRow {
  kind: "tool-group";
  id: string;
  turnId: string;
  summaryCount: number;
  sourceSeqStart: number;
  sourceSeqEnd: number;
  startedAt: number;
  createdAt: number;
  durationMs?: number;
  status: "pending" | "completed" | "error" | "interrupted";
  messages: CollapsibleTurnMessage[];
}

export type ThreadDetailRow = ThreadDetailMessageRow | ThreadDetailToolGroupRow;

export interface BuildThreadDetailRowsOptions {
  includeToolGroupMessages?: boolean;
}

function isCollapsibleTurnMessage(message: UIMessage): message is CollapsibleTurnMessage {
  if (
    message.kind === "operation" &&
    (message.opType === "compaction" || message.opType === "thread-title-updated")
  ) {
    return false;
  }
  if (message.kind === "user" || message.kind === "assistant-text") {
    return false;
  }
  return true;
}

function isToolExploringMessage(
  message: CollapsibleTurnMessage,
): message is Extract<UIMessage, { kind: "tool-exploring" }> {
  return message.kind === "tool-exploring";
}

function isFileEditMessage(
  message: CollapsibleTurnMessage,
): message is Extract<UIMessage, { kind: "file-edit" }> {
  return message.kind === "file-edit";
}

function isProvisioningOperation(
  message: UIMessage,
): message is Extract<UIMessage, { kind: "operation" }> {
  if (message.kind !== "operation") return false;
  // opType is open/external; unknown values are intentionally ignored.
  return (
    message.opType === "provisioning-started" ||
    message.opType === "provisioning-progress" ||
    message.opType === "provisioning-env-setup" ||
    message.opType === "provisioning-fallback" ||
    message.opType === "provisioning-completed" ||
    message.opType === "provisioning-cleanup-failed"
  );
}

function appendProvisioningOutput(
  existing: string | undefined,
  incoming: string | undefined,
): string | undefined {
  if (!incoming) return existing;
  if (!existing) return incoming;
  if (existing.endsWith("\n") || incoming.startsWith("\n")) {
    return `${existing}${incoming}`;
  }
  return `${existing}\n${incoming}`;
}

function mergeProvisioningSetup(
  existing: UIProvisioningSetupMetadata | undefined,
  incoming: UIProvisioningSetupMetadata | undefined,
): UIProvisioningSetupMetadata | undefined {
  if (!incoming) {
    return existing ? { ...existing } : undefined;
  }
  if (!existing) {
    return {
      ...incoming,
    };
  }

  return {
    status: incoming.status,
    startedAt: existing.startedAt ?? incoming.startedAt,
    scriptPath: incoming.scriptPath ?? existing.scriptPath,
    timeoutMs: incoming.timeoutMs ?? existing.timeoutMs,
    durationMs: incoming.durationMs ?? existing.durationMs,
    output: appendProvisioningOutput(existing.output, incoming.output),
  };
}

function provisioningTranscriptEntryKey(entry: UIProvisioningTranscriptEntry): string {
  return entry.key;
}

function mergeProvisioningTranscriptEntry(
  existing: UIProvisioningTranscriptEntry | undefined,
  incoming: UIProvisioningTranscriptEntry,
): UIProvisioningTranscriptEntry {
  if (!existing) {
    return {
      ...incoming,
      ...(incoming.metadata ? { metadata: { ...incoming.metadata } } : {}),
    };
  }

  const shouldPreserveStartedAt =
    incoming.startedAt === undefined &&
    existing.text === incoming.text;

  return {
    key: existing.key,
    text: incoming.text,
    ...(incoming.startedAt !== undefined
      ? { startedAt: existing.startedAt ?? incoming.startedAt }
      : shouldPreserveStartedAt && existing.startedAt !== undefined
        ? { startedAt: existing.startedAt }
        : {}),
    ...(incoming.metadata ? { metadata: { ...incoming.metadata } } : {}),
  };
}

function mergeProvisioningTranscript(
  existing: UIProvisioningTranscriptEntry[] | undefined,
  incoming: UIProvisioningTranscriptEntry[] | undefined,
): UIProvisioningTranscriptEntry[] | undefined {
  if (!incoming) {
    return existing?.map((entry) => mergeProvisioningTranscriptEntry(undefined, entry));
  }
  if (!existing) {
    return incoming.map((entry) => mergeProvisioningTranscriptEntry(undefined, entry));
  }

  const merged = new Map<string, UIProvisioningTranscriptEntry>();
  const order: string[] = [];
  for (const entry of existing) {
    const key = provisioningTranscriptEntryKey(entry);
    order.push(key);
    merged.set(key, mergeProvisioningTranscriptEntry(undefined, entry));
  }
  for (const entry of incoming) {
    const key = provisioningTranscriptEntryKey(entry);
    if (!merged.has(key)) {
      order.push(key);
    }
    merged.set(key, mergeProvisioningTranscriptEntry(merged.get(key), entry));
  }
  return order
    .map((key) => merged.get(key))
    .filter((entry): entry is UIProvisioningTranscriptEntry => Boolean(entry));
}

function mergeProvisioningMetadata(
  existing: UIProvisioningMetadata | undefined,
  incoming: UIProvisioningMetadata | undefined,
): UIProvisioningMetadata | undefined {
  if (!incoming) {
    return existing ? { ...existing } : undefined;
  }
  if (!existing) {
    return {
      ...incoming,
      ...(incoming.setup ? { setup: { ...incoming.setup } } : {}),
      ...(incoming.transcript
        ? { transcript: mergeProvisioningTranscript(undefined, incoming.transcript) }
        : {}),
    };
  }

  const setup = mergeProvisioningSetup(existing.setup, incoming.setup);
  const transcript = mergeProvisioningTranscript(existing.transcript, incoming.transcript);
  return {
    attachedEnvironmentId:
      incoming.attachedEnvironmentId ?? existing.attachedEnvironmentId,
    workspaceRoot: incoming.workspaceRoot ?? existing.workspaceRoot,
    ...(setup ? { setup } : {}),
    ...(transcript ? { transcript } : {}),
  };
}

function getMessageStartedAt(message: Pick<UIMessage, "createdAt" | "startedAt">): number {
  return message.startedAt ?? message.createdAt;
}

function getGroupDurationMs(messages: readonly Pick<UIMessage, "createdAt" | "startedAt">[]): number | undefined {
  if (messages.length === 0) return undefined;
  const startedAt = Math.min(...messages.map((message) => getMessageStartedAt(message)));
  const endedAt = Math.max(...messages.map((message) => message.createdAt));
  const durationMs = endedAt - startedAt;
  return durationMs > 0 ? durationMs : undefined;
}

function shouldNormalizeProvisioningLifecycleOperation(
  message: Extract<UIMessage, { kind: "operation" }>,
): boolean {
  return (
    message.opType === "provisioning-started" ||
    message.opType === "provisioning-progress" ||
    message.opType === "provisioning-env-setup" ||
    message.opType === "provisioning-completed"
  );
}

function mergeProvisioningOperations(messages: UIMessage[]): UIMessage[] {
  const merged: UIMessage[] = [];
  let active: Array<Extract<UIMessage, { kind: "operation" }>> = [];

  const flush = () => {
    if (active.length === 0) return;
    const single = active[0];
    if (active.length === 1 && single && !shouldNormalizeProvisioningLifecycleOperation(single)) {
      merged.push(single);
      active = [];
      return;
    }

    const first = active[0];
    const last = active[active.length - 1];
    if (!first || !last) {
      active = [];
      return;
    }

    const hasCompleted = active.some((message) => message.opType === "provisioning-completed");
    const hasLifecycleUpdate = active.some(
      (message) => message.opType !== "provisioning-env-setup",
    );
    const lastSetupUpdate = [...active]
      .reverse()
      .find((message) => message.opType === "provisioning-env-setup");
    const mergedStatus =
      active.some((message) => message.status === "error")
        ? "error"
        : hasCompleted
          ? "completed"
          : active.some((message) => message.status === "interrupted")
            ? "interrupted"
            : "pending";
    const details = active
      .map((message) => message.detail?.trim())
      .filter((value): value is string => Boolean(value));
    const uniqueDetailLines = [...new Set(details)];
    const provisioning = active.reduce<UIProvisioningMetadata | undefined>(
      (acc, message) => mergeProvisioningMetadata(acc, message.provisioning),
      undefined,
    );
    const title = (() => {
      if (mergedStatus === "interrupted") {
        if (!hasLifecycleUpdate && lastSetupUpdate) {
          return "Environment setup interrupted";
        }
        return "Provisioning environment interrupted";
      }
      if (mergedStatus === "error") {
        if (lastSetupUpdate) {
          return lastSetupUpdate.title === "Environment setup failed"
            ? "Environment setup failed"
            : lastSetupUpdate.title;
        }
        return "Provisioning environment failed";
      }
      if (!hasLifecycleUpdate && lastSetupUpdate) {
        switch (lastSetupUpdate.title) {
          case "Environment setup completed":
            return "Environment setup completed";
          case "Environment setup failed":
            return "Environment setup failed";
          default:
            return "Environment setup...";
        }
      }

      return hasCompleted ? "Provisioned environment" : "Provisioning environment";
    })();

    merged.push({
      kind: "operation",
      id: first.id,
      threadId: first.threadId,
      sourceSeqStart: Math.min(...active.map((message) => message.sourceSeqStart)),
      sourceSeqEnd: Math.max(...active.map((message) => message.sourceSeqEnd)),
      createdAt: Math.max(...active.map((message) => message.createdAt)),
      startedAt: Math.min(...active.map((message) => getMessageStartedAt(message))),
      turnId: first.turnId ?? last.turnId,
      opType: "provisioning",
      title,
      detail: uniqueDetailLines.length > 0 ? uniqueDetailLines.join("\n") : undefined,
      status: mergedStatus,
      ...(provisioning ? { provisioning } : {}),
    });

    active = [];
  };

  for (const message of messages) {
    if (!isProvisioningOperation(message)) {
      flush();
      merged.push(message);
      continue;
    }

    if (active.length === 0) {
      active = [message];
      continue;
    }

    if (message.opType === "provisioning-started") {
      flush();
      active = [message];
      continue;
    }

    active.push(message);
  }

  flush();
  return merged;
}

type PrimaryCheckoutAction = UIPrimaryCheckoutAction | "unknown";
type PrimaryCheckoutPhase = UIPrimaryCheckoutPhase;

function isPrimaryCheckoutOperation(
  message: UIMessage,
): message is Extract<UIMessage, { kind: "operation" }> {
  return message.kind === "operation" && message.opType === "primary-checkout";
}

function classifyPrimaryCheckoutOperation(message: Extract<UIMessage, { kind: "operation" }>): {
  action: PrimaryCheckoutAction;
  phase: PrimaryCheckoutPhase;
} | null {
  if (!message.primaryCheckout) {
    return null;
  }
  return {
    action: message.primaryCheckout.action,
    phase: message.primaryCheckout.phase,
  };
}

function mergePrimaryCheckoutOperations(messages: UIMessage[]): UIMessage[] {
  const merged: UIMessage[] = [];
  let active: Array<Extract<UIMessage, { kind: "operation" }>> = [];
  let activeAction: Exclude<PrimaryCheckoutAction, "unknown"> | null = null;

  const flush = () => {
    if (active.length === 0) return;
    if (active.length === 1) {
      merged.push(active[0]);
      active = [];
      activeAction = null;
      return;
    }

    const first = active[0];
    const last = active[active.length - 1];
    if (!first || !last) {
      active = [];
      activeAction = null;
      return;
    }

    const details = active
      .map((message) => message.detail?.trim())
      .filter((value): value is string => Boolean(value));
    const uniqueDetailLines = [...new Set(details)];

    merged.push({
      kind: "operation",
      id: `${first.id}:primary-checkout:${last.id}`,
      threadId: first.threadId,
      sourceSeqStart: Math.min(...active.map((message) => message.sourceSeqStart)),
      sourceSeqEnd: Math.max(...active.map((message) => message.sourceSeqEnd)),
      createdAt: Math.max(...active.map((message) => message.createdAt)),
      startedAt: Math.min(...active.map((message) => getMessageStartedAt(message))),
      turnId: first.turnId ?? last.turnId,
      opType: "primary-checkout",
      title: last.title,
      detail: uniqueDetailLines.length > 0 ? uniqueDetailLines.join("\n") : undefined,
      status: last.status,
      ...(last.primaryCheckout ? { primaryCheckout: last.primaryCheckout } : {}),
    });

    active = [];
    activeAction = null;
  };

  for (const message of messages) {
    if (!isPrimaryCheckoutOperation(message)) {
      flush();
      merged.push(message);
      continue;
    }

    const classified = classifyPrimaryCheckoutOperation(message);
    if (!classified || classified.action === "unknown") {
      flush();
      merged.push(message);
      continue;
    }

    if (active.length === 0) {
      active = [message];
      activeAction = classified.action;
      if (classified.phase !== "started") {
        flush();
      }
      continue;
    }

    if (activeAction !== classified.action || classified.phase === "started") {
      flush();
      active = [message];
      activeAction = classified.action;
      if (classified.phase !== "started") {
        flush();
      }
      continue;
    }

    active.push(message);
    flush();
  }

  flush();
  return mergePrimaryCheckoutCompletedRoundTrips(merged);
}

function mergePrimaryCheckoutCompletedRoundTrips(messages: UIMessage[]): UIMessage[] {
  const merged: UIMessage[] = [];

  for (let index = 0; index < messages.length; index += 1) {
    const promoted = messages[index];
    if (!promoted || !isPrimaryCheckoutOperation(promoted)) {
      if (promoted) {
        merged.push(promoted);
      }
      continue;
    }

    const promotedClass = classifyPrimaryCheckoutOperation(promoted);
    if (!promotedClass || promotedClass.action !== "promote" || promotedClass.phase !== "completed") {
      merged.push(promoted);
      continue;
    }

    const demoted = messages[index + 1];
    if (!demoted || !isPrimaryCheckoutOperation(demoted)) {
      merged.push(promoted);
      continue;
    }

    const demotedClass = classifyPrimaryCheckoutOperation(demoted);
    if (!demotedClass || demotedClass.action !== "demote" || demotedClass.phase !== "completed") {
      merged.push(promoted);
      continue;
    }

    const details = [promoted.detail?.trim(), demoted.detail?.trim()].filter(
      (value): value is string => Boolean(value),
    );
    const uniqueDetailLines = [...new Set(details)];

    merged.push({
      kind: "operation",
      id: `${promoted.id}:primary-checkout-roundtrip:${demoted.id}`,
      threadId: promoted.threadId,
      sourceSeqStart: Math.min(promoted.sourceSeqStart, demoted.sourceSeqStart),
      sourceSeqEnd: Math.max(promoted.sourceSeqEnd, demoted.sourceSeqEnd),
      createdAt: Math.max(promoted.createdAt, demoted.createdAt),
      startedAt: Math.min(getMessageStartedAt(promoted), getMessageStartedAt(demoted)),
      turnId: demoted.turnId ?? promoted.turnId,
      opType: "primary-checkout",
      title: "Promoted then demoted as primary checkout",
      detail: uniqueDetailLines.length > 0 ? uniqueDetailLines.join("\n") : undefined,
      status: "completed",
    });

    index += 1;
  }

  return merged;
}

type ThreadOperationIntentAction = UIThreadOperationIntentAction | "unknown";
type ThreadOperationIntentPhase = UIThreadOperationIntentPhase;

interface ClassifiedThreadOperationIntent {
  action: ThreadOperationIntentAction;
  phase: ThreadOperationIntentPhase;
  operationId?: string;
}

function isThreadOperationIntent(
  message: UIMessage,
): message is Extract<UIMessage, { kind: "operation" }> {
  return message.kind === "operation" && message.opType === "thread-operation-intent";
}

function classifyThreadOperationIntent(
  message: Extract<UIMessage, { kind: "operation" }>,
): ClassifiedThreadOperationIntent | null {
  if (!message.threadOperation) {
    return null;
  }
  return {
    action: message.threadOperation.action,
    phase: message.threadOperation.phase,
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

function isTerminalThreadOperationIntentPhase(phase: ThreadOperationIntentPhase): boolean {
  switch (phase) {
    case "completed":
    case "failed":
      return true;
    case "requested":
    case "queued":
    case "running":
    case "update":
      return false;
    default:
      return assertNever(phase);
  }
}

function mergeThreadOperationIntentMessages(messages: UIMessage[]): UIMessage[] {
  const merged: UIMessage[] = [];

  for (let index = 0; index < messages.length; index += 1) {
    const initial = messages[index];
    if (!initial || !isThreadOperationIntent(initial)) {
      if (initial) {
        merged.push(initial);
      }
      continue;
    }

    const initialClass = classifyThreadOperationIntent(initial);
    if (!initialClass || initialClass.action === "unknown") {
      merged.push(initial);
      continue;
    }

    let cursor = index + 1;
    let promptMessage: Extract<UIMessage, { kind: "user" }> | null = null;
    const promptCandidate = messages[cursor];
    if (
      initialClass.action === "squash_merge" &&
      initialClass.phase === "requested" &&
      promptCandidate?.kind === "user"
    ) {
      promptMessage = promptCandidate;
      cursor += 1;
    }

    const lifecycleMessages: Array<Extract<UIMessage, { kind: "operation" }>> = [initial];
    let sawTerminalLifecyclePhase = isTerminalThreadOperationIntentPhase(initialClass.phase);
    while (!sawTerminalLifecyclePhase) {
      const lifecycleCandidate = messages[cursor];
      if (!lifecycleCandidate || !isThreadOperationIntent(lifecycleCandidate)) {
        break;
      }
      const lifecycleClass = classifyThreadOperationIntent(lifecycleCandidate);
      if (!lifecycleClass) {
        break;
      }
      if (
        lifecycleClass.action !== initialClass.action ||
        lifecycleClass.phase === "requested" ||
        !areThreadOperationIdsCompatible(initialClass.operationId, lifecycleClass.operationId)
      ) {
        break;
      }
      lifecycleMessages.push(lifecycleCandidate);
      cursor += 1;
      if (isTerminalThreadOperationIntentPhase(lifecycleClass.phase)) {
        sawTerminalLifecyclePhase = true;
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
      id: `${initial.id}:thread-operation-intent:${lifecycleCandidate.id}`,
      threadId: initial.threadId,
      sourceSeqStart: Math.min(...sequence.map((message) => message.sourceSeqStart)),
      sourceSeqEnd: Math.max(...sequence.map((message) => message.sourceSeqEnd)),
      createdAt: Math.max(...sequence.map((message) => message.createdAt)),
      startedAt: Math.min(...sequence.map((message) => getMessageStartedAt(message))),
      turnId:
        lifecycleCandidate.turnId ??
        promptMessage?.turnId ??
        initial.turnId,
      opType: "thread-operation-intent",
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

function isWorktreeSquashMergeOperation(
  message: UIMessage,
): message is Extract<UIMessage, { kind: "operation" }> {
  return message.kind === "operation" && message.opType === "worktree-squash-merge";
}

function isWorktreeCommitOperation(
  message: UIMessage,
): message is Extract<UIMessage, { kind: "operation" }> {
  return message.kind === "operation" && message.opType === "worktree-commit";
}

function hasAdjacentThreadOperationOutcome(
  messages: UIMessage[],
  startIndex: number,
  direction: -1 | 1,
  action: Exclude<ThreadOperationIntentAction, "unknown">,
  operationId?: string,
): boolean {
  for (
    let cursor = startIndex + direction;
    cursor >= 0 && cursor < messages.length;
    cursor += direction
  ) {
    const candidate = messages[cursor];
    if (!candidate) break;

    switch (action) {
      case "commit":
        if (isWorktreeCommitOperation(candidate)) {
          return true;
        }
        break;
      case "squash_merge":
        if (isWorktreeSquashMergeOperation(candidate)) {
          return true;
        }
        break;
      default:
        return assertNever(action);
    }

    if (isThreadOperationIntent(candidate)) {
      const candidateClass = classifyThreadOperationIntent(candidate);
      if (!candidateClass) {
        return false;
      }
      if (candidateClass.action === action) {
        if (!areThreadOperationIdsCompatible(operationId, candidateClass.operationId)) {
          return false;
        }
        continue;
      }
      return false;
    }

    if (action === "squash_merge" && isWorktreeCommitOperation(candidate)) {
      continue;
    }

    return false;
  }

  return false;
}

function mergeThreadOperationOutcomeMessages(messages: UIMessage[]): UIMessage[] {
  const merged: UIMessage[] = [];

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (!message || !isThreadOperationIntent(message)) {
      if (message) {
        merged.push(message);
      }
      continue;
    }

    const classified = classifyThreadOperationIntent(message);
    if (!classified || classified.action === "unknown" || classified.phase === "failed") {
      merged.push(message);
      continue;
    }

    if (
      hasAdjacentThreadOperationOutcome(
        messages,
        index,
        1,
        classified.action,
        classified.operationId,
      ) ||
      hasAdjacentThreadOperationOutcome(
        messages,
        index,
        -1,
        classified.action,
        classified.operationId,
      )
    ) {
      continue;
    }

    merged.push(message);
  }

  return merged;
}

function mergeFileEditStatus(
  left: Extract<UIMessage, { kind: "file-edit" }>["status"],
  right: Extract<UIMessage, { kind: "file-edit" }>["status"],
): Extract<UIMessage, { kind: "file-edit" }>["status"] {
  const statusPriority = (status: Extract<UIMessage, { kind: "file-edit" }>["status"]): number => {
    switch (status) {
      case "completed":
        return 0;
      case "interrupted":
        return 1;
      case "pending":
        return 2;
      case "error":
        return 3;
      default:
        return assertNever(status);
    }
  };

  return statusPriority(left) >= statusPriority(right) ? left : right;
}

function parseReconnectAttempt(
  message: Extract<UIMessage, { kind: "error" }>,
): { attempt: number; total: number } | null {
  const match = message.message.trim().match(/^Reconnecting\.\.\.\s+(\d+)\/(\d+)$/);
  if (!match) return null;

  const attempt = Number.parseInt(match[1] ?? "", 10);
  const total = Number.parseInt(match[2] ?? "", 10);
  if (!Number.isFinite(attempt) || !Number.isFinite(total)) {
    return null;
  }
  if (attempt <= 0 || total <= 0 || attempt > total) {
    return null;
  }

  return { attempt, total };
}

function mergeConsecutiveReconnectErrors(messages: UIMessage[]): UIMessage[] {
  const merged: UIMessage[] = [];
  let active: Extract<UIMessage, { kind: "error" }> | null = null;
  let activeReconnect: { attempt: number; total: number } | null = null;

  const flush = () => {
    if (!active) return;
    merged.push(active);
    active = null;
    activeReconnect = null;
  };

  for (const message of messages) {
    if (message.kind !== "error") {
      flush();
      merged.push(message);
      continue;
    }

    const reconnect = parseReconnectAttempt(message);
    if (!reconnect) {
      flush();
      merged.push(message);
      continue;
    }

    if (!active || !activeReconnect) {
      active = { ...message };
      activeReconnect = reconnect;
      continue;
    }

    const isSameTurn = (active.turnId ?? null) === (message.turnId ?? null);
    const isSameThread = active.threadId === message.threadId;
    const isSameRawType = active.rawType === message.rawType;
    const isSameRetryBudget = activeReconnect.total === reconnect.total;
    const isNextAttempt = reconnect.attempt === activeReconnect.attempt + 1;

    if (
      isSameTurn &&
      isSameThread &&
      isSameRawType &&
      isSameRetryBudget &&
      isNextAttempt
    ) {
      active = {
        ...message,
        id: `${active.id}:reconnect:${message.id}`,
        sourceSeqStart: Math.min(active.sourceSeqStart, message.sourceSeqStart),
        sourceSeqEnd: Math.max(active.sourceSeqEnd, message.sourceSeqEnd),
        createdAt: Math.max(active.createdAt, message.createdAt),
        startedAt: Math.min(getMessageStartedAt(active), getMessageStartedAt(message)),
        turnId: active.turnId ?? message.turnId,
      };
      activeReconnect = reconnect;
      continue;
    }

    flush();
    active = { ...message };
    activeReconnect = reconnect;
  }

  flush();
  return merged;
}

function mergeConsecutiveToolActivityMessages(
  messages: CollapsibleTurnMessage[],
): CollapsibleTurnMessage[] {
  const merged: CollapsibleTurnMessage[] = [];
  let active:
    | Extract<UIMessage, { kind: "tool-exploring" }>
    | Extract<UIMessage, { kind: "file-edit" }>
    | null = null;

  const flush = () => {
    if (!active) return;
    merged.push(active);
    active = null;
  };

  for (const message of messages) {
    if (!isToolExploringMessage(message) && !isFileEditMessage(message)) {
      flush();
      merged.push(message);
      continue;
    }

    if (!active) {
      active = isToolExploringMessage(message)
        ? {
            ...message,
            calls: [...message.calls],
          }
        : {
            ...message,
            changes: message.changes.map((change) => ({ ...change })),
          };
      continue;
    }

    if ((active.turnId ?? null) !== (message.turnId ?? null)) {
      flush();
      active = isToolExploringMessage(message)
        ? {
            ...message,
            calls: [...message.calls],
          }
        : {
            ...message,
            changes: message.changes.map((change) => ({ ...change })),
          };
      continue;
    }

    if (isToolExploringMessage(active) && isToolExploringMessage(message)) {
      active.calls = [...active.calls, ...message.calls];
      active.sourceSeqStart = Math.min(active.sourceSeqStart, message.sourceSeqStart);
      active.sourceSeqEnd = Math.max(active.sourceSeqEnd, message.sourceSeqEnd);
      active.createdAt = Math.max(active.createdAt, message.createdAt);
      active.startedAt = Math.min(getMessageStartedAt(active), getMessageStartedAt(message));
      if (!active.turnId && message.turnId) {
        active.turnId = message.turnId;
      }
      active.status =
        active.status === "pending" || message.status === "pending"
          ? "pending"
          : "completed";
      continue;
    }

    if (isFileEditMessage(active) && isFileEditMessage(message)) {
      active.changes = [
        ...active.changes,
        ...message.changes.map((change) => ({ ...change })),
      ];
      active.sourceSeqStart = Math.min(active.sourceSeqStart, message.sourceSeqStart);
      active.sourceSeqEnd = Math.max(active.sourceSeqEnd, message.sourceSeqEnd);
      active.createdAt = Math.max(active.createdAt, message.createdAt);
      active.startedAt = Math.min(getMessageStartedAt(active), getMessageStartedAt(message));
      if (!active.turnId && message.turnId) {
        active.turnId = message.turnId;
      }
      active.status = mergeFileEditStatus(active.status, message.status);
      if (message.stdout) {
        active.stdout = message.stdout;
      }
      if (message.stderr) {
        active.stderr = message.stderr;
      }
      continue;
    }

    flush();
    active = isToolExploringMessage(message)
      ? {
          ...message,
          calls: [...message.calls],
        }
      : {
          ...message,
          changes: message.changes.map((change) => ({ ...change })),
        };
  }

  flush();
  return merged;
}

function getToolGroupSummaryCount(messages: CollapsibleTurnMessage[]): number {
  return messages.reduce((count, message) => {
    if (message.kind === "tool-exploring") {
      return count + Math.max(1, message.calls.length);
    }
    if (message.kind === "file-edit") {
      return count + Math.max(1, message.changes.length);
    }
    return count + 1;
  }, 0);
}

function getSourceSeqRange(messages: CollapsibleTurnMessage[]): {
  sourceSeqStart: number;
  sourceSeqEnd: number;
} {
  const sourceSeqStart = Math.min(...messages.map((message) => message.sourceSeqStart));
  const sourceSeqEnd = Math.max(...messages.map((message) => message.sourceSeqEnd));
  return { sourceSeqStart, sourceSeqEnd };
}

function getCollapsibleTurnMessageStatus(
  message: CollapsibleTurnMessage,
): ThreadDetailToolGroupRow["status"] {
  switch (message.kind) {
    case "user":
      return "completed";
    case "assistant-reasoning":
    case "assistant-text":
      return "completed";
    case "tool-exploring":
    case "tool-call":
    case "web-search":
    case "file-edit":
      return message.status;
    case "operation":
      return message.status ?? "completed";
    case "error":
      return "error";
    case "debug/raw-event":
      return "completed";
    default:
      return assertNever(message);
  }
}

function mergeToolGroupStatus(
  left: ThreadDetailToolGroupRow["status"],
  right: ThreadDetailToolGroupRow["status"],
): ThreadDetailToolGroupRow["status"] {
  const priority = (status: ThreadDetailToolGroupRow["status"]): number => {
    switch (status) {
      case "completed":
        return 0;
      case "interrupted":
        return 1;
      case "pending":
        return 2;
      case "error":
        return 3;
      default:
        return assertNever(status);
    }
  };

  return priority(left) >= priority(right) ? left : right;
}

function getToolGroupStatus(messages: CollapsibleTurnMessage[]): ThreadDetailToolGroupRow["status"] {
  return messages.reduce<ThreadDetailToolGroupRow["status"]>(
    (status, message) => mergeToolGroupStatus(status, getCollapsibleTurnMessageStatus(message)),
    "completed",
  );
}

function enrichWorktreeSquashMergeMessages(messages: UIMessage[]): UIMessage[] {
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

export function buildThreadDetailRows(
  messages: UIMessage[],
  options?: BuildThreadDetailRowsOptions,
): ThreadDetailRow[] {
  // Timeline guardrail: keep one canonical row per user-visible operation whenever possible.
  // If new lifecycle/outcome events are added, update these collapse passes so thread timelines
  // stay familiar across projections instead of showing near-duplicate status updates.
  const includeToolGroupMessages = options?.includeToolGroupMessages ?? true;
  const provisioningMergedMessages = mergeProvisioningOperations(messages);
  const primaryCheckoutMergedMessages = mergePrimaryCheckoutOperations(provisioningMergedMessages);
  const threadOperationMergedMessages = mergeThreadOperationIntentMessages(
    primaryCheckoutMergedMessages,
  );
  const operationOutcomeMergedMessages = mergeThreadOperationOutcomeMessages(
    threadOperationMergedMessages,
  );
  const worktreeOutcomeEnrichedMessages = enrichWorktreeSquashMergeMessages(
    operationOutcomeMergedMessages,
  );
  const reconnectMergedMessages = mergeConsecutiveReconnectErrors(
    worktreeOutcomeEnrichedMessages,
  );
  const mergedMessages = mergeConsecutiveToolActivityMessages(reconnectMergedMessages);
  const lastAssistantIndexByTurn = new Map<string, number>();

  for (const [index, message] of mergedMessages.entries()) {
    if (!message.turnId) continue;
    if (message.kind !== "assistant-text") continue;
    lastAssistantIndexByTurn.set(message.turnId, index);
  }

  const collapsedByFirstIndex = new Map<
    number,
    {
      indices: Set<number>;
      messages: CollapsibleTurnMessage[];
      turnId: string;
    }
  >();
  const collapsedMessageIndices = new Set<number>();

  for (let index = 0; index < mergedMessages.length; index += 1) {
    const message = mergedMessages[index];
    const turnId = message?.turnId;
    if (!turnId) continue;

    const lastAssistantIndex = lastAssistantIndexByTurn.get(turnId);
    if (lastAssistantIndex === undefined || index >= lastAssistantIndex) continue;
    if (!isCollapsibleTurnMessage(message)) continue;

    const previousMessage = index > 0 ? mergedMessages[index - 1] : undefined;
    const continuesPriorGroup =
      previousMessage?.turnId === turnId && isCollapsibleTurnMessage(previousMessage);
    if (continuesPriorGroup) {
      continue;
    }

    const indices = new Set<number>();
    const messages: CollapsibleTurnMessage[] = [];
    let scanIndex = index;
    while (scanIndex < mergedMessages.length) {
      const candidate = mergedMessages[scanIndex];
      if (
        !candidate ||
        candidate.turnId !== turnId ||
        !isCollapsibleTurnMessage(candidate) ||
        scanIndex >= lastAssistantIndex
      ) {
        break;
      }
      indices.add(scanIndex);
      collapsedMessageIndices.add(scanIndex);
      messages.push(candidate);
      scanIndex += 1;
    }

    collapsedByFirstIndex.set(index, {
      indices,
      messages,
      turnId,
    });
  }

  const rows: ThreadDetailRow[] = [];

  for (const [index, message] of mergedMessages.entries()) {
    const collapseGroup = collapsedByFirstIndex.get(index);

    if (collapseGroup) {
      const mergedGroupMessages = includeToolGroupMessages
        ? mergeConsecutiveToolActivityMessages(collapseGroup.messages)
        : [];
      const { sourceSeqStart, sourceSeqEnd } = getSourceSeqRange(collapseGroup.messages);
      rows.push({
        kind: "tool-group",
        id: `${collapseGroup.turnId}:tool-group:${index}`,
        turnId: collapseGroup.turnId,
        summaryCount: getToolGroupSummaryCount(collapseGroup.messages),
        sourceSeqStart,
        sourceSeqEnd,
        startedAt: Math.min(...collapseGroup.messages.map((message) => getMessageStartedAt(message))),
        createdAt: Math.max(...collapseGroup.messages.map((message) => message.createdAt)),
        durationMs: getGroupDurationMs(collapseGroup.messages),
        status: getToolGroupStatus(collapseGroup.messages),
        messages: mergedGroupMessages,
      });
    }

    if (collapsedMessageIndices.has(index)) {
      continue;
    }

    rows.push({
      kind: "message",
      id: message.id,
      message,
    });
  }

  return rows;
}
