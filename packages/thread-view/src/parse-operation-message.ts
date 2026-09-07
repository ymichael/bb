import type {
  ApprovalInteractionLifecycle,
  PendingInteractionPermissionGrantApprovalSubject,
  ThreadEvent,
  SystemThreadProvisioningStatus,
  SystemThreadInterruptedReason,
  UserQuestionInteractionLifecycle,
} from "@bb/domain";
import {
  THREAD_CONTEXT_CLEAR_OPERATION,
  isApprovalInteractionLifecycle,
  isUserQuestionInteractionLifecycle,
  ownershipChangeOperationMetadataSchema,
} from "@bb/domain";
import { assertNever } from "./assert-never.js";
import { getCompactionKey } from "./compaction-lifecycle.js";
import { OWNERSHIP_CHANGE_VERBS } from "./family-a-verbs.js";
import type { EventMeta } from "./event-decode.js";
import { capitalize, messageId } from "./format-helpers.js";
import { buildProviderUnhandledDetail } from "./provider-unhandled-detail.js";
import {
  provisioningTitleForStatus,
  readProvisioningTranscript,
} from "./provisioning-helpers.js";
import type {
  BuildEventProjectionMessagesOptions,
  EventProjectionPermissionGrantGrantScope,
  EventProjectionPermissionGrantLifecycleMessage,
  EventProjectionPermissionGrantLifecycle,
  EventProjectionUserQuestionLifecycle,
  EventProjectionUserQuestionLifecycleMessage,
  EventProjectionOperationMessage,
  EventProjectionOwnershipChangeThreadOperationMetadata,
  EventProjectionThreadOperationMetadata,
  EventProjectionThreadOperationKind,
  EventProjectionThreadOperationStatus,
} from "./event-projection-types.js";
import { getProviderModelFallbackData } from "./model-fallback-extraction.js";

type ParseOperationMessageOptions = Pick<
  BuildEventProjectionMessagesOptions,
  "includeProviderUnhandledOperations" | "providerDisplayName" | "threadName"
>;

function withThreadName(threadName: string, verb: string): string {
  const name = threadName.trim();
  return name.length > 0 ? `${name} ${verb}` : capitalize(verb);
}

type InteractionLifecycleEvent = Extract<
  ThreadEvent,
  { type: "system/interaction/lifecycle" }
>;

function providerDisplayName(
  providerId: string,
  projectedDisplayName: string | undefined,
): string {
  return projectedDisplayName?.trim() || providerId;
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

function threadInterruptedTitle(
  reason: SystemThreadInterruptedReason,
  cause?: "host-connection-lost",
): string {
  if (cause === "host-connection-lost") {
    return "Stopped — connection to host was lost";
  }
  switch (reason) {
    case "manual-stop":
      return "Stopped manually";
    case "host-daemon-restarted":
      return "Stopped — host daemon restarted";
    case "provider-turn-idle":
      return "Stopped — provider turn stopped responding";
    default:
      return assertNever(reason);
  }
}

function ownershipTitleWithParent(
  threadName: string,
  verb: string,
  parentTitle: string | null,
): string {
  const parent =
    parentTitle !== null && parentTitle.trim().length > 0
      ? parentTitle.trim()
      : "parent";
  return withThreadName(threadName, `${verb} ${parent}`);
}

function ownershipChangeOperationTitle(
  meta: EventProjectionOwnershipChangeThreadOperationMetadata,
  threadName: string,
): string {
  switch (meta.status) {
    case "completed": {
      const action = meta.metadata?.action;
      switch (action) {
        case "assign":
          return ownershipTitleWithParent(
            threadName,
            OWNERSHIP_CHANGE_VERBS.assign,
            meta.metadata?.nextParentThreadTitle ?? null,
          );
        case "release":
          return ownershipTitleWithParent(
            threadName,
            OWNERSHIP_CHANGE_VERBS.release,
            meta.metadata?.previousParentThreadTitle ?? null,
          );
        case "transfer":
          return ownershipTitleWithParent(
            threadName,
            OWNERSHIP_CHANGE_VERBS.transfer,
            meta.metadata?.nextParentThreadTitle ?? null,
          );
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

function threadOperationTitle(
  meta: EventProjectionThreadOperationMetadata | null,
  threadName: string,
): string {
  if (!meta) return "Operation update";

  switch (meta.operation) {
    case "ownership_change":
      return ownershipChangeOperationTitle(meta, threadName);
    case "other":
      if (
        meta.rawOperation === THREAD_CONTEXT_CLEAR_OPERATION &&
        meta.status === "completed"
      ) {
        return "Context cleared";
      }
      return `${capitalize(meta.rawOperation.replace(/_/g, " "))} ${
        meta.rawStatus
      }`;
    default:
      return assertNever(meta);
  }
}

function threadOperationStatus(
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
    case "cancelled":
      return "interrupted";
  }
}

function permissionGrantLifecycle(
  interaction: ApprovalInteractionLifecycle,
): EventProjectionPermissionGrantLifecycle {
  switch (interaction.status) {
    case "pending":
      return "pending";
    case "resolving":
      return "resolving";
    case "resolved":
      return interaction.resolution?.decision === "deny" ? "denied" : "granted";
    case "interrupted":
      return "interrupted";
    default:
      return assertNever(interaction.status);
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
    default:
      return assertNever(lifecycle);
  }
}

function permissionGrantScope(
  interaction: ApprovalInteractionLifecycle,
): EventProjectionPermissionGrantGrantScope | null {
  const decision = interaction.resolution?.decision;
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
  decoded: InteractionLifecycleEvent,
  interaction: ApprovalInteractionLifecycle,
  subject: PendingInteractionPermissionGrantApprovalSubject,
  meta: EventMeta,
): EventProjectionPermissionGrantLifecycleMessage {
  const lifecycle = permissionGrantLifecycle(interaction);
  return {
    kind: "permission-grant-lifecycle",
    id: messageId(decoded.threadId, "approval", interaction.id),
    threadId: decoded.threadId,
    sourceSeqStart: meta.seq,
    sourceSeqEnd: meta.seq,
    createdAt: meta.createdAt,
    startedAt: meta.createdAt,
    scope: decoded.scope,
    interactionId: interaction.id,
    lifecycle,
    status: permissionGrantLifecycleStatus(lifecycle),
    approvalTarget: {
      itemId: subject.itemId,
      toolName: subject.toolName,
    },
    grantScope: permissionGrantScope(interaction),
    statusReason: interaction.statusReason,
  };
}

function userQuestionLifecycle(
  interaction: UserQuestionInteractionLifecycle,
): EventProjectionUserQuestionLifecycle {
  switch (interaction.status) {
    case "pending":
      return "pending";
    case "resolving":
      return "resolving";
    case "resolved":
      return "answered";
    case "interrupted":
      return "interrupted";
    default:
      return assertNever(interaction.status);
  }
}

function userQuestionLifecycleStatus(
  lifecycle: EventProjectionUserQuestionLifecycle,
): EventProjectionUserQuestionLifecycleMessage["status"] {
  switch (lifecycle) {
    case "pending":
    case "resolving":
      return "pending";
    case "answered":
      return "completed";
    case "interrupted":
      return "interrupted";
    default:
      return assertNever(lifecycle);
  }
}

function buildUserQuestionLifecycleMessage(
  decoded: InteractionLifecycleEvent,
  interaction: UserQuestionInteractionLifecycle,
  meta: EventMeta,
): EventProjectionUserQuestionLifecycleMessage {
  const lifecycle = userQuestionLifecycle(interaction);
  return {
    kind: "user-question-lifecycle",
    id: messageId(decoded.threadId, "question", interaction.id),
    threadId: decoded.threadId,
    sourceSeqStart: meta.seq,
    sourceSeqEnd: meta.seq,
    createdAt: meta.createdAt,
    startedAt: meta.createdAt,
    scope: decoded.scope,
    interactionId: interaction.id,
    lifecycle,
    status: userQuestionLifecycleStatus(lifecycle),
    questions: interaction.payload.questions,
    answers: interaction.resolution?.answers ?? null,
    statusReason: interaction.statusReason,
  };
}

function buildInteractionLifecycleMessage(
  decoded: InteractionLifecycleEvent,
  meta: EventMeta,
):
  | EventProjectionPermissionGrantLifecycleMessage
  | EventProjectionUserQuestionLifecycleMessage
  | null {
  const { interaction } = decoded;
  if (isUserQuestionInteractionLifecycle(interaction)) {
    return buildUserQuestionLifecycleMessage(decoded, interaction, meta);
  }
  if (!isApprovalInteractionLifecycle(interaction)) {
    return null;
  }
  const subject = interaction.payload.subject;
  return subject.kind === "permission_grant"
    ? buildPermissionGrantLifecycleMessage(decoded, interaction, subject, meta)
    : null;
}

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
  | EventProjectionUserQuestionLifecycleMessage
  | null {
  const threadName = options?.threadName ?? "";
  const modelFallback = getProviderModelFallbackData(decoded);
  if (modelFallback !== null) {
    return op(decoded, meta, "warning", {
      opType: "warning",
      title: `Model fallback: ${modelFallback.originalModel} → ${modelFallback.fallbackModel}`,
      detail: modelFallback.message,
      status: "completed",
    });
  }

  if (decoded.type === "provider/unhandled") {
    if (options?.includeProviderUnhandledOperations !== true) {
      return null;
    }

    return op(decoded, meta, "provider-unhandled", {
      opType: "provider-unhandled",
      title: `Unhandled ${providerDisplayName(
        decoded.providerId,
        options?.providerDisplayName,
      )} event`,
      detail: buildProviderUnhandledDetail(decoded),
      status: "completed",
    });
  }

  if (decoded.type === "provider.env-resolved") {
    const detail = decoded.entries
      .map((entry) => {
        const source = entry.source === "shell" ? "shell" : entry.source.plugin;
        const value = typeof entry.value === "string" ? entry.value : "••••••";
        const reason = entry.reason ? ` — ${entry.reason}` : "";
        return `${entry.name}=${value} (${source})${reason}`;
      })
      .join("\n");
    return op(decoded, meta, "provider-environment", {
      opType: "provider-environment",
      title: "Provider environment resolved",
      detail: detail || undefined,
      status: "completed",
    });
  }

  if (decoded.type === "provider/warning") {
    const category = decoded.category;
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
      title: threadInterruptedTitle(decoded.reason, decoded.cause),
      status: "interrupted",
    });
  }

  if (decoded.type === "system/provider-turn-watchdog") {
    return op(decoded, meta, "provider-turn-watchdog", {
      opType: "operation",
      title: "Provider turn stopped responding",
      detail: `No provider activity for ${Math.round(
        decoded.elapsedMs / 1_000,
      )}s after ${decoded.lastActivityEventType}`,
      status: "error",
    });
  }

  if (decoded.type === "system/thread-provisioning") {
    const { status, environmentId, provisioningId } = decoded;
    if (provisioningId.startsWith("thread-start:")) {
      return null;
    }
    const transcript = readProvisioningTranscript(decoded.entries);
    const operationStatus = provisioningOperationStatus(status);
    return op(decoded, meta, "thread-provisioning", {
      opType: "thread-provisioning",
      title: provisioningTitleForStatus(operationStatus),
      status: operationStatus,
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
    if (
      decoded.operation === "plugin_interaction" ||
      decoded.operation === "edit_message"
    ) {
      return null;
    }

    const threadOperation = createThreadOperationMetadata(decoded);
    const title = threadOperationTitle(threadOperation, threadName);

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

  if (decoded.type === "system/interaction/lifecycle") {
    return buildInteractionLifecycleMessage(decoded, meta);
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

  if (decoded.type === "thread/context/cleared") {
    return op(decoded, meta, "context-clear", {
      opType: "context-clear",
      title: "Context cleared",
      status: "completed",
    });
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
      message.title = provisioningTitleForStatus("interrupted");
      return;
    case "compaction":
      message.title = "Context compaction interrupted";
      return;
    case "context-clear":
      message.title = "Context clear interrupted";
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
        message.title = provisioningTitleForStatus("error");
        message.completedAt = message.createdAt;
        return;
      default:
        break;
    }
  }

  interruptOperationMessage(message);
}
