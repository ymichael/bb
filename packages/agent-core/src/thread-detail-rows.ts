import { assertNever } from "./assert-never.js";
import type { UIMessage } from "./ui-message.js";

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
  return message.kind !== "user";
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
    message.opType === "provisioning-env-setup" ||
    message.opType === "provisioning-fallback" ||
    message.opType === "provisioning-completed" ||
    message.opType === "provisioning-cleanup-failed"
  );
}

function parseProvisioningEnvironment(detail: string | undefined): string | undefined {
  if (!detail) return undefined;
  const fromEnvironmentPrefix = detail.match(/^Environment:\s*(.+)$/);
  if (fromEnvironmentPrefix?.[1]) {
    return fromEnvironmentPrefix[1].trim();
  }
  const [firstToken] = detail.split(" • ");
  const value = firstToken?.trim();
  return value && value.length > 0 ? value : undefined;
}

function mergeProvisioningOperations(messages: UIMessage[]): UIMessage[] {
  const merged: UIMessage[] = [];
  let active: Array<Extract<UIMessage, { kind: "operation" }>> = [];

  const flush = () => {
    if (active.length === 0) return;
    if (active.length === 1) {
      merged.push(active[0]);
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
    const details = active
      .map((message) => message.detail?.trim())
      .filter((value): value is string => Boolean(value));
    const uniqueDetailLines = [...new Set(details)];
    const environment =
      active
        .filter((message) => message.opType !== "provisioning-env-setup")
        .map((message) => parseProvisioningEnvironment(message.detail))
        .find((value): value is string => Boolean(value)) ?? "environment";

    merged.push({
      kind: "operation",
      id: `${first.id}:provisioning:${last.id}`,
      threadId: first.threadId,
      sourceSeqStart: Math.min(...active.map((message) => message.sourceSeqStart)),
      sourceSeqEnd: Math.max(...active.map((message) => message.sourceSeqEnd)),
      createdAt: Math.max(...active.map((message) => message.createdAt)),
      turnId: first.turnId ?? last.turnId,
      opType: "provisioning",
      title: hasCompleted ? `Provisioned ${environment}` : `Provisioning ${environment}...`,
      detail: uniqueDetailLines.length > 0 ? uniqueDetailLines.join("\n") : undefined,
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

type PrimaryCheckoutAction = "promote" | "demote" | "unknown";
type PrimaryCheckoutPhase = "started" | "completed" | "failed" | "noop" | "update";

function isPrimaryCheckoutOperation(
  message: UIMessage,
): message is Extract<UIMessage, { kind: "operation" }> {
  return message.kind === "operation" && message.opType === "primary-checkout";
}

function classifyPrimaryCheckoutOperation(message: Extract<UIMessage, { kind: "operation" }>): {
  action: PrimaryCheckoutAction;
  phase: PrimaryCheckoutPhase;
} {
  switch (message.title) {
    case "Promoting primary checkout":
      return { action: "promote", phase: "started" };
    case "Promoted to primary checkout":
      return { action: "promote", phase: "completed" };
    case "Primary checkout promotion failed":
      return { action: "promote", phase: "failed" };
    case "Primary checkout already promoted":
      return { action: "promote", phase: "noop" };
    case "Demoting primary checkout":
      return { action: "demote", phase: "started" };
    case "Demoted from primary checkout":
      return { action: "demote", phase: "completed" };
    case "Primary checkout demotion failed":
      return { action: "demote", phase: "failed" };
    case "Primary checkout already demoted":
      return { action: "demote", phase: "noop" };
    default: {
      const normalizedTitle = message.title.toLowerCase();
      // Operation titles are persisted/read-time open_external; unknown values are intentionally tolerated.
      if (normalizedTitle.includes("promot")) {
        return { action: "promote", phase: "update" };
      }
      if (normalizedTitle.includes("demot")) {
        return { action: "demote", phase: "update" };
      }
      return { action: "unknown", phase: "update" };
    }
  }
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
      turnId: first.turnId ?? last.turnId,
      opType: "primary-checkout",
      title: last.title,
      detail: uniqueDetailLines.length > 0 ? uniqueDetailLines.join("\n") : undefined,
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
    if (classified.action === "unknown") {
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

export function buildThreadDetailRows(
  messages: UIMessage[],
  options?: BuildThreadDetailRowsOptions,
): ThreadDetailRow[] {
  const includeToolGroupMessages = options?.includeToolGroupMessages ?? true;
  const provisioningMergedMessages = mergeProvisioningOperations(messages);
  const primaryCheckoutMergedMessages = mergePrimaryCheckoutOperations(provisioningMergedMessages);
  const mergedMessages = mergeConsecutiveToolActivityMessages(primaryCheckoutMergedMessages);
  const lastAssistantIndexByTurn = new Map<string, number>();

  for (const [index, message] of mergedMessages.entries()) {
    if (!message.turnId) continue;
    if (message.kind !== "assistant-text") continue;
    lastAssistantIndexByTurn.set(message.turnId, index);
  }

  const collapsedByTurn = new Map<
    string,
    {
      firstIndex: number;
      indices: Set<number>;
      messages: CollapsibleTurnMessage[];
    }
  >();

  for (const [index, message] of mergedMessages.entries()) {
    const turnId = message.turnId;
    if (!turnId) continue;

    const lastAssistantIndex = lastAssistantIndexByTurn.get(turnId);
    if (lastAssistantIndex === undefined || index >= lastAssistantIndex) continue;
    if (!isCollapsibleTurnMessage(message)) continue;

    const existing = collapsedByTurn.get(turnId);
    if (!existing) {
      collapsedByTurn.set(turnId, {
        firstIndex: index,
        indices: new Set([index]),
        messages: [message],
      });
      continue;
    }

    existing.firstIndex = Math.min(existing.firstIndex, index);
    existing.indices.add(index);
    existing.messages.push(message);
  }

  const rows: ThreadDetailRow[] = [];

  for (const [index, message] of mergedMessages.entries()) {
    const turnId = message.turnId;
    const collapseGroup = turnId ? collapsedByTurn.get(turnId) : undefined;

    if (turnId && collapseGroup && index === collapseGroup.firstIndex) {
      const mergedGroupMessages = includeToolGroupMessages
        ? mergeConsecutiveToolActivityMessages(collapseGroup.messages)
        : [];
      const { sourceSeqStart, sourceSeqEnd } = getSourceSeqRange(collapseGroup.messages);
      rows.push({
        kind: "tool-group",
        id: `${turnId}:tool-group:${collapseGroup.firstIndex}`,
        turnId,
        summaryCount: getToolGroupSummaryCount(collapseGroup.messages),
        sourceSeqStart,
        sourceSeqEnd,
        messages: mergedGroupMessages,
      });
    }

    if (turnId && collapseGroup?.indices.has(index)) {
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
