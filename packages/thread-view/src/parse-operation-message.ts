import type {
  ThreadEvent,
  SystemThreadProvisioningStatus,
  SystemThreadInterruptedReason,
} from "@bb/domain";
import { ownershipChangeOperationMetadataSchema } from "@bb/domain";
import { assertNever } from "./assert-never.js";
import { getCompactionKey } from "./compaction-lifecycle.js";
import type { EventMeta } from "./event-decode.js";
import { capitalize, messageId } from "./format-helpers.js";
import { buildProviderUnhandledDetail } from "./provider-unhandled-detail.js";
import { readProvisioningTranscript } from "./provisioning-helpers.js";
import type {
  BuildEventProjectionMessagesOptions,
  EventProjectionPermissionGrantGrantScope,
  EventProjectionPermissionGrantLifecycleMessage,
  EventProjectionPermissionGrantLifecycle,
  EventProjectionOperationMessage,
  EventProjectionOwnershipChangeThreadOperationMetadata,
  EventProjectionThreadOperationMetadata,
  EventProjectionThreadOperationKind,
  EventProjectionThreadOperationStatus,
} from "./event-projection-types.js";

type ParseOperationMessageOptions = Pick<
  BuildEventProjectionMessagesOptions,
  "includeProviderUnhandledOperations"
>;

type PermissionGrantLifecycleEvent = Extract<
  ThreadEvent,
  { type: "system/permissionGrant/lifecycle" }
>;

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

function normalizeThreadOperationKind(
  rawOperation: string,
): EventProjectionThreadOperationKind {
  if (rawOperation === "ownership_change") return "ownership_change";
  return "other";
}

function normalizeThreadOperationStatus(
  rawStatus: string,
): EventProjectionThreadOperationStatus {
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
): EventProjectionThreadOperationMetadata {
  const operation = normalizeThreadOperationKind(decoded.operation);
  const base = {
    rawOperation: decoded.operation,
    status: normalizeThreadOperationStatus(decoded.status),
    rawStatus: decoded.status,
    operationId: decoded.operationId,
  };
  if (operation === "ownership_change") {
    const parsedMetadata = decoded.metadata
      ? ownershipChangeOperationMetadataSchema.safeParse(decoded.metadata)
      : null;
    return {
      ...base,
      operation,
      metadata: parsedMetadata?.success ? parsedMetadata.data : null,
    };
  }
  return {
    ...base,
    operation,
    ...(decoded.metadata ? { metadata: decoded.metadata } : {}),
  };
}

function threadInterruptedTitle(reason: SystemThreadInterruptedReason): string {
  switch (reason) {
    case "manual-stop":
      return "Stopped manually";
    case "host-daemon-restarted":
      return "Host daemon restarted";
    default:
      return assertNever(reason);
  }
}

function ownershipChangeOperationTitle(
  meta: EventProjectionOwnershipChangeThreadOperationMetadata,
): string {
  switch (meta.status) {
    case "completed": {
      const action = meta.metadata?.action;
      switch (action) {
        case "assign":
          return "Thread assigned to manager";
        case "release":
          return "Thread released from manager";
        case "transfer":
          return "Thread transferred to new manager";
        case undefined:
          return "Ownership change completed";
        default:
          return assertNever(action);
      }
    }
    case "failed":
      return "Ownership change failed";
    default:
      return `Ownership change ${meta.rawStatus}`;
  }
}

export function threadOperationTitle(
  meta: EventProjectionThreadOperationMetadata | null,
): string {
  if (!meta) return "Operation update";

  switch (meta.operation) {
    case "ownership_change":
      return ownershipChangeOperationTitle(meta);
    case "other":
      return `${capitalize(meta.rawOperation.replace(/_/g, " "))} ${
        meta.rawStatus
      }`;
    default:
      return assertNever(meta);
  }
}

export function threadOperationStatus(
  meta: EventProjectionThreadOperationMetadata | null,
): EventProjectionOperationMessage["status"] {
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
): EventProjectionOperationMessage["status"] {
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

function permissionGrantLifecycle(
  decoded: PermissionGrantLifecycleEvent,
): EventProjectionPermissionGrantLifecycle {
  switch (decoded.status) {
    case "pending":
      return "pending";
    case "resolving":
      return "resolving";
    case "resolved":
      return decoded.resolution?.decision === "deny" ? "denied" : "granted";
    case "interrupted":
      return "interrupted";
    case "expired":
      return "expired";
    default:
      return assertNever(decoded.status);
  }
}

function permissionGrantLifecycleStatus(
  lifecycle: EventProjectionPermissionGrantLifecycle,
): EventProjectionPermissionGrantLifecycleMessage["status"] {
  switch (lifecycle) {
    case "pending":
    case "resolving":
      return "pending";
    case "granted":
    case "denied":
      return "completed";
    case "interrupted":
      return "interrupted";
    case "expired":
      return "error";
    default:
      return assertNever(lifecycle);
  }
}

function permissionGrantScope(
  decoded: PermissionGrantLifecycleEvent,
): EventProjectionPermissionGrantGrantScope | null {
  const decision = decoded.resolution?.decision;
  switch (decision) {
    case "allow_once":
      return "turn";
    case "allow_for_session":
      return "session";
    case "deny":
    case undefined:
      return null;
    default:
      return assertNever(decision);
  }
}

function buildPermissionGrantLifecycleMessage(
  decoded: PermissionGrantLifecycleEvent,
  meta: EventMeta,
): EventProjectionPermissionGrantLifecycleMessage {
  const lifecycle = permissionGrantLifecycle(decoded);
  return {
    kind: "permission-grant-lifecycle",
    id: messageId(decoded.threadId, "approval", decoded.interactionId),
    threadId: decoded.threadId,
    sourceSeqStart: meta.seq,
    sourceSeqEnd: meta.seq,
    createdAt: meta.createdAt,
    startedAt: meta.createdAt,
    scope: decoded.scope,
    interactionId: decoded.interactionId,
    lifecycle,
    status: permissionGrantLifecycleStatus(lifecycle),
    approvalTarget: {
      itemId: decoded.subject.itemId,
      toolName: decoded.subject.toolName,
    },
    grantScope: permissionGrantScope(decoded),
    statusReason: decoded.statusReason,
  };
}

/** Build the common scaffolding shared by all operation messages. */
function op(
  decoded: ThreadEvent,
  meta: EventMeta,
  idKey: string,
  fields: ViewOperationFields,
): EventProjectionOperationMessage {
  const completedAt = isTerminalOperationStatus(fields.status)
    ? meta.createdAt
    : null;
  return {
    kind: "operation",
    id: messageId(decoded.threadId, "op", `${idKey}:${meta.seq}`),
    threadId: decoded.threadId,
    sourceSeqStart: meta.seq,
    sourceSeqEnd: meta.seq,
    createdAt: meta.createdAt,
    startedAt: meta.createdAt,
    completedAt,
    scope: decoded.scope,
    ...fields,
  };
}

function isTerminalOperationStatus(
  status: EventProjectionOperationMessage["status"],
): boolean {
  return (
    status === "completed" || status === "error" || status === "interrupted"
  );
}

type ViewOperationFields = Omit<
  EventProjectionOperationMessage,
  | "kind"
  | "id"
  | "threadId"
  | "sourceSeqStart"
  | "sourceSeqEnd"
  | "createdAt"
  | "startedAt"
  | "completedAt"
  | "scope"
  | "turnId"
>;

export function parseOperationMessage(
  decoded: ThreadEvent,
  meta: EventMeta,
  options?: ParseOperationMessageOptions,
):
  | EventProjectionOperationMessage
  | EventProjectionPermissionGrantLifecycleMessage
  | null {
  if (decoded.type === "provider/unhandled") {
    if (options?.includeProviderUnhandledOperations !== true) {
      return null;
    }

    return op(decoded, meta, "provider-unhandled", {
      opType: "provider-unhandled",
      title: `Unhandled ${providerDisplayName(decoded.providerId)} event`,
      detail: buildProviderUnhandledDetail(decoded),
      status: "completed",
    });
  }

  if (decoded.type === "provider/warning") {
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
      opType: isDeprecation ? "deprecation" : "warning",
      title,
      detail: detail.length > 0 ? detail : undefined,
      status: "completed",
    });
  }

  if (decoded.type === "system/thread/interrupted") {
    return op(decoded, meta, "thread-interrupted", {
      opType: "thread-interrupted",
      title: threadInterruptedTitle(decoded.reason),
      status: "interrupted",
    });
  }

  if (decoded.type === "system/thread-provisioning") {
    const { status, environmentId, provisioningId } = decoded;
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
      opType: "thread-provisioning",
      title,
      status: provisioningOperationStatus(status),
      provisioning: {
        environmentId,
        provisioningId,
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

    const branch =
      typeof decoded.metadata?.branch === "string"
        ? decoded.metadata.branch
        : undefined;
    const messageDetail = decoded.message.trim();
    const detailParts = [
      messageDetail.length > 0 && messageDetail !== title
        ? messageDetail
        : undefined,
      branch ? `Branch: ${branch}` : undefined,
    ].filter((value): value is string => Boolean(value));

    return op(decoded, meta, "operation", {
      opType: "operation",
      title,
      detail: detailParts.length > 0 ? detailParts.join(" • ") : undefined,
      status: threadOperationStatus(threadOperation),
      threadOperation,
    });
  }

  if (decoded.type === "system/permissionGrant/lifecycle") {
    return buildPermissionGrantLifecycleMessage(decoded, meta);
  }

  if (decoded.type === "thread/compacted") {
    return {
      ...op(decoded, meta, `compaction`, {
        opType: "compaction",
        title: "Context compacted",
        status: "completed",
      }),
      id: messageId(
        decoded.threadId,
        "op",
        `compaction:${getCompactionKey(decoded, meta)}`,
      ),
    };
  }

  return null;
}

export function interruptOperationMessage(
  message: EventProjectionOperationMessage,
): void {
  if (message.status !== "pending") return;
  message.status = "interrupted";
  message.completedAt = message.createdAt;

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
  message: EventProjectionOperationMessage,
  options: BuildEventProjectionMessagesOptions | undefined,
): void {
  if (message.status !== "pending") return;

  if (options?.threadStatus === "error") {
    switch (message.opType) {
      case "thread-provisioning":
        message.status = "error";
        message.title = "Provisioning thread failed";
        message.completedAt = message.createdAt;
        return;
      default:
        break;
    }
  }

  interruptOperationMessage(message);
}
