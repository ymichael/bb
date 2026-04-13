import type {
  ThreadEvent,
  ThreadEventPlanStepStatus,
  SystemThreadProvisioningStatus,
  ViewThreadOperationKind,
  ViewThreadOperationStatus,
} from "@bb/domain";
import { getCompactionKey } from "./compaction-lifecycle.js";
import type { EventMeta } from "./event-decode.js";
import { getEventTurnId } from "./event-decode.js";
import { capitalize, messageId } from "./format-helpers.js";
import { buildProviderUnhandledDetail } from "./provider-unhandled-detail.js";
import {
  readProvisioningTranscript,
} from "./provisioning-helpers.js";
import type {
  ToViewMessagesOptions,
  ViewOperationMessage,
  ViewThreadOperationMetadata,
} from "@bb/domain";

function providerDisplayName(providerId: string): string {
  switch (providerId) {
    case "claude-code":
      return "Claude Code";
    case "codex":
      return "Codex";
    case "pi":
      return "Pi";
    default:
      return providerId;
  }
}

function normalizeThreadOperationKind(rawOperation: string): ViewThreadOperationKind {
  if (rawOperation === "ownership_change") return "ownership_change";
  return "other";
}

function normalizeThreadOperationStatus(rawStatus: string): ViewThreadOperationStatus {
  switch (rawStatus) {
    case "requested":
    case "queued":
    case "running":
    case "started":
    case "completed":
    case "failed":
    case "noop":
      return rawStatus;
    default:
      return "other";
  }
}

function createThreadOperationMetadata(
  decoded: Extract<ThreadEvent, { type: "system/operation" }>,
): ViewThreadOperationMetadata {
  return {
    operation: normalizeThreadOperationKind(decoded.operation),
    rawOperation: decoded.operation,
    status: normalizeThreadOperationStatus(decoded.status),
    rawStatus: decoded.status,
    ...(decoded.operationId ? { operationId: decoded.operationId } : {}),
    ...(decoded.metadata ? { metadata: decoded.metadata } : {}),
  };
}

export function threadOperationTitle(meta: ViewThreadOperationMetadata | null): string {
  if (!meta) return "Operation update";

  const { operation, rawOperation, status, rawStatus, metadata } = meta;

  switch (operation) {
    case "ownership_change": {
      const action = typeof metadata?.action === "string" ? metadata.action : undefined;
      switch (status) {
        case "completed":
          return action === "release"
            ? "Thread management transferred"
            : "Thread assigned to manager";
        case "failed":
          return "Ownership change failed";
        default:
          return `Ownership change ${rawStatus}`;
      }
    }
    case "other":
      return `${capitalize(rawOperation.replace(/_/g, " "))} ${rawStatus}`;
  }
}

export function threadOperationStatus(
  meta: ViewThreadOperationMetadata | null,
): ViewOperationMessage["status"] {
  if (!meta) return undefined;
  switch (meta.status) {
    case "requested":
    case "queued":
    case "running":
    case "started":
      return "pending";
    case "completed":
    case "noop":
      return "completed";
    case "failed":
      return "error";
    case "other":
      return "pending";
  }
}

function provisioningOperationStatus(
  status: SystemThreadProvisioningStatus,
): ViewOperationMessage["status"] {
  switch (status) {
    case "active":
      return "pending";
    case "completed":
      return "completed";
    case "failed":
      return "error";
    default:
      return "pending";
  }
}

/** Build the common scaffolding shared by all operation messages. */
function op(
  decoded: ThreadEvent,
  meta: EventMeta,
  idKey: string,
  fields: ViewOperationFields,
): ViewOperationMessage {
  return {
    kind: "operation",
    id: messageId(decoded.threadId, "op", `${idKey}:${meta.seq}`),
    threadId: decoded.threadId,
    sourceSeqStart: meta.seq,
    sourceSeqEnd: meta.seq,
    createdAt: meta.createdAt,
    startedAt: meta.createdAt,
    ...fields,
  };
}

type ViewOperationFields = Omit<
  ViewOperationMessage,
  "kind" | "id" | "threadId" | "sourceSeqStart" | "sourceSeqEnd" | "createdAt" | "startedAt"
>;

function formatPlanStepStatus(status: ThreadEventPlanStepStatus | undefined): string {
  switch (status) {
    case "active":
      return "In progress";
    case "pending":
      return "Pending";
    case "completed":
      return "Completed";
    case "failed":
      return "Failed";
    default:
      return "";
  }
}

export function parseOperationMessage(
  decoded: ThreadEvent,
  meta: EventMeta,
  options?: { includeOptionalOperations?: boolean },
): ViewOperationMessage | null {
  const eventTurnId = getEventTurnId(decoded);

  if (decoded.type === "turn/plan/updated") {
    const steps = decoded.plan
      .map((entry) => {
        const status = entry.status;
        const text = entry.step;
        if (!text) return null;
        return status
          ? `• [${formatPlanStepStatus(status)}] ${text}`
          : `• ${text}`;
      })
      .filter((value): value is string => Boolean(value));

    const detail =
      decoded.explanation && steps.length > 0
        ? `${decoded.explanation}\n${steps.join("\n")}`
        : decoded.explanation ?? (steps.length > 0 ? steps.join("\n") : undefined);

    return op(decoded, meta, "plan", {
      turnId: decoded.turnId,
      opType: "plan-updated",
      title: "Plan updated",
      detail,
      status: "completed",
    });
  }

  if (decoded.type === "provider/unhandled") {
    return op(decoded, meta, "provider-unhandled", {
      turnId: eventTurnId,
      opType: "provider-unhandled",
      title: `Unhandled ${providerDisplayName(decoded.providerId)} event`,
      detail: buildProviderUnhandledDetail(decoded),
      status: "completed",
    });
  }

  if (decoded.type === "warning") {
    const category = decoded.category ?? "general";
    const isDeprecation = category === "deprecation";
    const isConfig = category === "config";
    const title = isDeprecation
      ? "Deprecation notice"
      : isConfig
        ? "Configuration warning"
        : decoded.summary?.trim() || "Warning";
    const detail = (
      isDeprecation || isConfig
        ? [decoded.summary, decoded.details]
        : [decoded.details]
    )
      .filter((line): line is string => Boolean(line))
      .join("\n");
    return op(decoded, meta, isDeprecation ? "deprecation" : "warning", {
      turnId: eventTurnId,
      opType: isDeprecation ? "deprecation" : "warning",
      title,
      detail: detail.length > 0 ? detail : undefined,
      status: "completed",
    });
  }

  if (decoded.type === "system/thread/interrupted") {
    return op(decoded, meta, "thread-interrupted", {
      turnId: eventTurnId,
      opType: "thread-interrupted",
      title: "Stopped by user",
      detail: decoded.message || undefined,
      status: "interrupted",
    });
  }

  if (decoded.type === "system/thread-provisioning") {
    const { status, environmentId } = decoded;
    const transcript = readProvisioningTranscript(decoded.entries);
    const title = (() => {
      switch (status) {
        case "active":
          return "Provisioning thread";
        case "completed":
          return "Provisioned thread";
        case "failed":
          return "Provisioning thread failed";
        default:
          return "Provisioning thread";
      }
    })();
    return op(decoded, meta, "thread-provisioning", {
      turnId: eventTurnId,
      opType: "thread-provisioning",
      title,
      status: provisioningOperationStatus(status),
      provisioning: {
        environmentId,
        ...(transcript ? { transcript } : {}),
      },
    });
  }

  if (decoded.type === "thread/name/updated") {
    return null;
  }

  if (decoded.type === "system/operation") {
    const threadOperation = createThreadOperationMetadata(decoded);
    const title = threadOperationTitle(threadOperation);

    const branch = typeof decoded.metadata?.branch === "string" ? decoded.metadata.branch : undefined;
    const detailParts = [
      decoded.message,
      branch ? `Branch: ${branch}` : undefined,
    ].filter((value): value is string => Boolean(value));

    return op(decoded, meta, "operation", {
      turnId: eventTurnId,
      opType: "operation",
      title,
      detail: detailParts.length > 0 ? detailParts.join(" • ") : undefined,
      status: threadOperationStatus(threadOperation),
      threadOperation,
    });
  }

  if (decoded.type === "thread/compacted") {
    return {
      ...op(decoded, meta, `compaction`, {
        turnId: eventTurnId,
        opType: "compaction",
        title: "Context compacted",
        status: "completed",
      }),
      id: messageId(decoded.threadId, "op", `compaction:${getCompactionKey(decoded, meta)}`),
    };
  }

  if (
    options?.includeOptionalOperations &&
    decoded.type === "turn/diff/updated"
  ) {
    return op(decoded, meta, "turn-diff", {
      turnId: decoded.turnId,
      opType: "turn-diff",
      title: "Turn diff updated",
      detail: decoded.diff,
    });
  }

  return null;
}

export function interruptOperationMessage(message: ViewOperationMessage): void {
  if (message.status !== "pending") return;
  message.status = "interrupted";

  switch (message.opType) {
    case "operation":
      message.title = "Operation interrupted";
      return;
    case "thread-provisioning":
      message.title = "Provisioning thread interrupted";
      return;
    case "compaction":
      message.title = "Context compaction interrupted";
      return;
    default:
      return;
  }
}

export function finalizeOperationMessage(
  message: ViewOperationMessage,
  options: ToViewMessagesOptions | undefined,
): void {
  if (message.status !== "pending") return;

  if (options?.threadStatus === "error") {
    switch (message.opType) {
      case "thread-provisioning":
        message.status = "error";
        message.title = "Provisioning thread failed";
        return;
      default:
        break;
    }
  }

  interruptOperationMessage(message);
}
