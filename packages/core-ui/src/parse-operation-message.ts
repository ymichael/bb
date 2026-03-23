import type { ThreadEvent, ThreadEventPlanStepStatus } from "@bb/domain";
import { assertNever } from "./assert-never.js";
import { getCompactionKey } from "./compaction-lifecycle.js";
import type { EventMeta } from "./event-decode.js";
import { getEventTurnId } from "./event-decode.js";
import { capitalize, messageId } from "./format-helpers.js";
import {
  getProvisioningProgressFromTranscript,
  provisioningProgressTitle,
  readProvisioningTranscript,
} from "./provisioning-helpers.js";
import type {
  ToUIMessagesOptions,
  UIOperationMessage,
  UIProvisioningSetupStatus,
  UIThreadOperationMetadata,
  UIWorktreeCommitMetadata,
  UIWorktreeSquashMergeMetadata,
} from "@bb/domain";

export function threadOperationTitle(meta: UIThreadOperationMetadata | null): string {
  if (!meta) return "Operation update";

  const { operation, status, metadata } = meta;

  switch (operation) {
    case "commit":
      switch (status) {
        case "running":
          return "Committing changes";
        case "completed":
          return "Changes committed";
        case "failed":
          return "Commit failed";
        case "requested":
          return "Commit requested";
        case "queued":
          return "Commit queued";
        case "noop":
          return "No commit needed";
        default:
          return `Commit ${status}`;
      }
    case "squash_merge":
      switch (status) {
        case "running":
          return "Squash merging";
        case "completed":
          return "Squash merged";
        case "failed":
          return "Squash merge failed";
        case "requested":
          return "Squash merge requested";
        case "queued":
          return "Squash merge queued";
        case "noop":
          return "No squash merge needed";
        default:
          return `Squash merge ${status}`;
      }
    case "primary_checkout": {
      const action = typeof metadata?.action === "string" ? metadata.action : undefined;
      const verb = action === "demote" ? "Demoting from" : "Promoting to";
      const past = action === "demote" ? "Demoted from" : "Promoted to";
      switch (status) {
        case "started":
        case "running":
          return `${verb} primary checkout`;
        case "completed":
          return `${past} primary checkout`;
        case "failed":
          return `Primary checkout ${action ?? "update"} failed`;
        case "noop":
          return `Primary checkout already ${action === "demote" ? "demoted" : "promoted"}`;
        default:
          return `Primary checkout ${status}`;
      }
    }
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
          return `Ownership change ${status}`;
      }
    }
    default:
      // open_external: unknown operations get a generic label.
      return `${capitalize(operation.replace(/_/g, " "))} ${status}`;
  }
}

export function threadOperationStatus(
  meta: UIThreadOperationMetadata | null,
): UIOperationMessage["status"] {
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
    default:
      // open_external: unknown statuses treated as pending.
      return "pending";
  }
}

function provisioningSetupOperationStatus(
  status: UIProvisioningSetupStatus | undefined,
): UIOperationMessage["status"] {
  if (!status) return undefined;
  switch (status) {
    case "started":
    case "running":
      return "pending";
    case "completed":
      return "completed";
    case "failed":
      return "error";
    default:
      return assertNever(status);
  }
}

function provisioningProgressOperationStatus(
  status: "started" | "completed" | "failed" | undefined,
): UIOperationMessage["status"] {
  if (!status) return undefined;
  switch (status) {
    case "started":
      return "pending";
    case "completed":
      return "completed";
    case "failed":
      return "error";
    default:
      return assertNever(status);
  }
}

/** Build the common scaffolding shared by all operation messages. */
function op(
  decoded: ThreadEvent,
  meta: EventMeta,
  idKey: string,
  fields: Omit<UIOperationMessage, "kind" | "id" | "threadId" | "sourceSeqStart" | "sourceSeqEnd" | "createdAt" | "startedAt">,
): UIOperationMessage {
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
): UIOperationMessage | null {
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

  if (decoded.type === "item/mcpToolCall/progress") {
    return op(decoded, meta, "mcp-progress", {
      turnId: decoded.turnId,
      opType: "mcp-progress",
      title: "MCP tool progress",
      detail: decoded.message || undefined,
      status: "pending",
    });
  }

  if (decoded.type === "warning") {
    const category = decoded.category ?? "general";
    const detail = decoded.summary ?? decoded.details;
    const isDeprecation = category === "deprecation";
    return op(decoded, meta, isDeprecation ? "deprecation" : "warning", {
      turnId: eventTurnId,
      opType: isDeprecation ? "deprecation" : "warning",
      title: isDeprecation ? "Deprecation notice" : category === "config" ? "Configuration warning" : "Warning",
      detail: detail || undefined,
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

  if (decoded.type === "system/provisioning/started") {
    const { attachedEnvironmentId } = decoded;
    const transcript = readProvisioningTranscript(decoded.transcript);
    return op(decoded, meta, "provisioning-started", {
      turnId: eventTurnId,
      opType: "provisioning-started",
      title: "Provisioning started",
      status: "pending",
      provisioning:
        attachedEnvironmentId || transcript
          ? {
              ...(attachedEnvironmentId ? { attachedEnvironmentId } : {}),
              ...(transcript ? { transcript } : {}),
            }
          : undefined,
    });
  }

  if (decoded.type === "system/provisioning/progress") {
    const transcript = readProvisioningTranscript(decoded.transcript);
    const phase: "prepare_environment" | "start_provider_session" | undefined =
      decoded.phase ?? getProvisioningProgressFromTranscript(transcript).phase;
    const status: "started" | "completed" | "failed" | undefined =
      decoded.status ?? getProvisioningProgressFromTranscript(transcript).status;

    return op(decoded, meta, "provisioning-progress", {
      turnId: eventTurnId,
      opType: "provisioning-progress",
      title: provisioningProgressTitle(phase, status),
      status: provisioningProgressOperationStatus(status),
      ...(transcript ? { provisioning: { transcript } } : {}),
    });
  }

  if (decoded.type === "system/provisioning/env_setup") {
    const { setup, workspaceRoot } = decoded;
    const status = setup.status;
    const title = (() => {
      switch (status) {
        case "started":
          return "Environment setup started";
        case "running":
          return "Environment setup running";
        case "completed":
          return "Environment setup completed";
        case "failed":
          return "Environment setup failed";
        default:
          return "Environment setup update";
      }
    })();
    const setupMetadata =
      status
        ? {
            status,
            startedAt: meta.createdAt,
            ...(setup.scriptPath ? { scriptPath: setup.scriptPath } : {}),
            ...(setup.timeoutMs !== undefined ? { timeoutMs: setup.timeoutMs } : {}),
            ...(setup.durationMs !== undefined ? { durationMs: setup.durationMs } : {}),
            ...(setup.output ? { output: setup.output } : {}),
          }
        : undefined;
    const transcript = readProvisioningTranscript(decoded.transcript);

    return op(decoded, meta, "provisioning-env-setup", {
      turnId: eventTurnId,
      opType: "provisioning-env-setup",
      title,
      status: provisioningSetupOperationStatus(status),
      ...(status && setupMetadata
        ? {
            provisioning: {
              ...(workspaceRoot ? { workspaceRoot } : {}),
              setup: setupMetadata,
              ...(transcript ? { transcript } : {}),
            },
          }
        : {}),
    });
  }

  if (decoded.type === "system/thread-title/updated") {
    // Avoid duplicate rows when the underlying provider thread/name/updated
    // event is also present in the timeline.
    if ((decoded.providerMethod ?? "") === "thread/name/updated") {
      return null;
    }
    const { title } = decoded;
    if (!title) return null;
    const { previousTitle } = decoded;
    return op(decoded, meta, "thread-title-updated", {
      turnId: eventTurnId,
      opType: "thread-title-updated",
      title: "Title updated",
      detail: previousTitle ? `${previousTitle} → ${title}` : title,
      status: "completed",
    });
  }

  if (decoded.type === "thread/name/updated") {
    const { threadName } = decoded;
    if (!threadName) return null;
    return op(decoded, meta, "thread-title-updated", {
      turnId: eventTurnId,
      opType: "thread-title-updated",
      title: "Title updated",
      detail: threadName,
      status: "completed",
    });
  }

  if (decoded.type === "system/operation") {
    const threadOperation: UIThreadOperationMetadata = {
      operation: decoded.operation,
      status: decoded.status,
      ...(decoded.operationId ? { operationId: decoded.operationId } : {}),
      ...(decoded.metadata ? { metadata: decoded.metadata } : {}),
    };
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
      ...(threadOperation ? { threadOperation } : {}),
    });
  }

  if (decoded.type === "system/worktree/commit") {
    const { status } = decoded;
    const title = status === "committed" ? "Committed changes" : "No commit created";
    const { message: commitMessage, commitSha, commitSubject, includeUnstaged } = decoded;
    const worktreeCommit: UIWorktreeCommitMetadata | undefined =
      status === "committed" || status === "noop"
        ? {
            status,
            ...(commitMessage ? { message: commitMessage } : {}),
            ...(commitSha ? { commitSha } : {}),
            ...(commitSubject ? { commitSubject } : {}),
            ...(typeof includeUnstaged === "boolean" ? { includeUnstaged } : {}),
          }
        : undefined;
    const detailParts = [
      commitSubject ?? commitMessage,
      commitSha,
    ].filter((value): value is string => Boolean(value));
    return op(decoded, meta, "worktree-commit", {
      turnId: eventTurnId,
      opType: "worktree-commit",
      title,
      detail: detailParts.length > 0 ? detailParts.join(" • ") : undefined,
      status: "completed",
      ...(worktreeCommit ? { worktreeCommit } : {}),
    });
  }

  if (decoded.type === "system/worktree/squash_merge") {
    const { status } = decoded;
    const { message: squashMessage, commitSha, commitSubject, mergeBaseBranch, committed, conflictFiles } = decoded;
    const normalizedConflictFiles = Array.isArray(conflictFiles)
      ? conflictFiles
          .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
          .slice(0, 8)
      : [];
    const worktreeSquashMerge: UIWorktreeSquashMergeMetadata | undefined =
      status === "merged" || status === "noop" || status === "conflict"
        ? {
            status,
            ...(squashMessage ? { message: squashMessage } : {}),
            ...(typeof committed === "boolean" ? { committed } : {}),
            ...(commitSha ? { commitSha } : {}),
            ...(commitSubject ? { commitSubject } : {}),
            ...(mergeBaseBranch ? { mergeBaseBranch } : {}),
            ...(normalizedConflictFiles.length > 0
              ? { conflictFiles: normalizedConflictFiles }
              : {}),
          }
        : undefined;
    const title = status === "merged"
      ? "Squash merged"
      : status === "conflict"
        ? "Squash merge has conflicts"
        : "No squash merge performed";
    const detailParts = [
      squashMessage,
      ...(normalizedConflictFiles.length > 0
        ? [`Conflicts: ${normalizedConflictFiles.join(", ")}`]
        : []),
    ].filter((value): value is string => Boolean(value));
    return op(decoded, meta, "worktree-squash-merge", {
      turnId: eventTurnId,
      opType: "worktree-squash-merge",
      title,
      detail: detailParts.length > 0 ? detailParts.join(" • ") : undefined,
      status: status === "conflict" ? "error" : "completed",
      ...(worktreeSquashMerge ? { worktreeSquashMerge } : {}),
    });
  }

  if (decoded.type === "system/provisioning/fallback") {
    const { fallbackEnvironmentId, detail } = decoded;
    const transcript = readProvisioningTranscript(decoded.transcript);
    return op(decoded, meta, "provisioning-fallback", {
      turnId: eventTurnId,
      opType: "provisioning-fallback",
      title: "Provisioning fallback",
      detail: detail || undefined,
      status: "pending",
      provisioning:
        fallbackEnvironmentId || transcript
          ? { ...(transcript ? { transcript } : {}) }
          : undefined,
    });
  }

  if (decoded.type === "system/provisioning/completed") {
    const { attachedEnvironmentId, workspaceRoot } = decoded;
    const transcript = readProvisioningTranscript(decoded.transcript);
    return op(decoded, meta, "provisioning-completed", {
      turnId: eventTurnId,
      opType: "provisioning-completed",
      title: "Provisioning ready",
      status: "completed",
      provisioning:
        attachedEnvironmentId || workspaceRoot || transcript
          ? {
              ...(attachedEnvironmentId ? { attachedEnvironmentId } : {}),
              ...(workspaceRoot ? { workspaceRoot } : {}),
              ...(transcript ? { transcript } : {}),
            }
          : undefined,
    });
  }

  if (decoded.type === "system/provisioning/cleanup_failed") {
    const detailParts = [
      decoded.message,
      decoded.detail,
    ].filter((value): value is string => Boolean(value));
    return op(decoded, meta, "provisioning-cleanup-failed", {
      turnId: eventTurnId,
      opType: "provisioning-cleanup-failed",
      title: "Provisioning cleanup failed",
      detail: detailParts.length > 0 ? detailParts.join(" • ") : undefined,
      status: "error",
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

export function interruptOperationMessage(message: UIOperationMessage): void {
  if (message.status !== "pending") return;
  message.status = "interrupted";

  switch (message.opType) {
    case "operation":
      switch (message.threadOperation?.operation) {
        case "commit":
          message.title = "Commit interrupted";
          return;
        case "squash_merge":
          message.title = "Squash merge interrupted";
          return;
        case "primary_checkout":
          message.title = "Primary checkout interrupted";
          return;
        default:
          message.title = "Operation interrupted";
          return;
      }
    case "provisioning-started":
    case "provisioning-fallback":
      message.title = "Provisioning interrupted";
      return;
    case "provisioning-progress":
      message.title = "Provisioning interrupted";
      return;
    case "provisioning-env-setup":
      message.title = "Environment setup interrupted";
      return;
    case "mcp-progress":
      message.title = "MCP tool progress interrupted";
      return;
    case "compaction":
      message.title = "Context compaction interrupted";
      return;
    default:
      return;
  }
}

export function finalizeOperationMessage(
  message: UIOperationMessage,
  options: ToUIMessagesOptions | undefined,
): void {
  if (message.status !== "pending") return;

  if (options?.threadStatus === "provisioning_failed") {
    switch (message.opType) {
      case "provisioning-started":
      case "provisioning-fallback":
        message.status = "error";
        message.title = "Provisioning failed";
        return;
      case "provisioning-progress":
        message.status = "error";
        if (
          getProvisioningProgressFromTranscript(message.provisioning?.transcript).phase ===
          "prepare_environment"
        ) {
          message.title = "Environment preparation failed";
          return;
        }
        if (
          getProvisioningProgressFromTranscript(message.provisioning?.transcript).phase ===
          "start_provider_session"
        ) {
          message.title = "Provider session start failed";
          return;
        }
        message.title = "Provisioning failed";
        return;
      case "provisioning-env-setup":
        message.status = "error";
        message.title = "Environment setup failed";
        return;
      default:
        break;
    }
  }

  interruptOperationMessage(message);
}
