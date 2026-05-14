import { assertNever } from "@bb/core-ui";
import type {
  PendingInteraction,
  PendingInteractionApprovalSubject,
  PendingInteractionPermissionGrantApprovalSubject,
  ThreadEventItemApprovalStatus,
  ThreadEventItem,
} from "@bb/domain";
import { turnScope } from "@bb/domain";
import { getThread, type DbNotifier, type DbTransaction } from "@bb/db";
import type { AppDeps } from "../../types.js";
import {
  appendThreadEvent,
  appendThreadEventInTransaction,
} from "../threads/thread-events.js";

interface PendingInteractionTimelineTransactionDeps {
  db: DbTransaction;
  hub: DbNotifier;
}

type ApprovalTimelineItem = Extract<
  ThreadEventItem,
  { type: "commandExecution" | "fileChange" }
>;
type ApprovalTimelineItemStatus = Extract<
  ApprovalTimelineItem["status"],
  "pending" | "interrupted"
>;

function appendPermissionGrantTimelineEvent(
  deps: Pick<AppDeps, "db" | "hub">,
  interaction: PendingInteraction,
  subject: PendingInteractionPermissionGrantApprovalSubject,
): void {
  const thread = getThread(deps.db, interaction.threadId);
  appendThreadEvent(deps, {
    threadId: interaction.threadId,
    environmentId: thread?.environmentId ?? null,
    type: "system/permissionGrant/lifecycle",
    scope: turnScope(interaction.turnId),
    data: {
      status: interaction.status,
      resolution: interaction.resolution,
      interactionId: interaction.id,
      providerId: interaction.providerId,
      providerRequestId: interaction.providerRequestId,
      statusReason: interaction.statusReason,
      subject,
    },
  });
}

function appendPermissionGrantTimelineEventInTransaction(
  deps: PendingInteractionTimelineTransactionDeps,
  interaction: PendingInteraction,
  subject: PendingInteractionPermissionGrantApprovalSubject,
): void {
  const thread = getThread(deps.db, interaction.threadId);
  appendThreadEventInTransaction(deps.db, {
    threadId: interaction.threadId,
    environmentId: thread?.environmentId ?? null,
    type: "system/permissionGrant/lifecycle",
    scope: turnScope(interaction.turnId),
    data: {
      status: interaction.status,
      resolution: interaction.resolution,
      interactionId: interaction.id,
      providerId: interaction.providerId,
      providerRequestId: interaction.providerRequestId,
      statusReason: interaction.statusReason,
      subject,
    },
  });
  deps.hub.notifyThread(interaction.threadId, ["events-appended"], {
    eventTypes: ["system/permissionGrant/lifecycle"],
  });
}

function appendApprovalItemEvent(
  deps: Pick<AppDeps, "db" | "hub">,
  interaction: PendingInteraction,
  item: ApprovalTimelineItem,
): void {
  const thread = getThread(deps.db, interaction.threadId);
  appendThreadEvent(deps, {
    threadId: interaction.threadId,
    environmentId: thread?.environmentId ?? null,
    type: item.status === "pending" ? "item/started" : "item/completed",
    providerThreadId: interaction.providerThreadId,
    scope: turnScope(interaction.turnId),
    data: {
      providerThreadId: interaction.providerThreadId,
      item,
    },
  });
}

function appendApprovalItemEventInTransaction(
  deps: PendingInteractionTimelineTransactionDeps,
  interaction: PendingInteraction,
  item: ApprovalTimelineItem,
): void {
  const thread = getThread(deps.db, interaction.threadId);
  appendThreadEventInTransaction(deps.db, {
    threadId: interaction.threadId,
    environmentId: thread?.environmentId ?? null,
    type: item.status === "pending" ? "item/started" : "item/completed",
    providerThreadId: interaction.providerThreadId,
    scope: turnScope(interaction.turnId),
    data: {
      providerThreadId: interaction.providerThreadId,
      item,
    },
  });
  deps.hub.notifyThread(interaction.threadId, ["events-appended"], {
    eventTypes: [item.status === "pending" ? "item/started" : "item/completed"],
  });
}

function appendApprovalSubjectItemEvent(
  deps: Pick<AppDeps, "db" | "hub">,
  interaction: PendingInteraction,
  subject: Exclude<
    PendingInteractionApprovalSubject,
    { kind: "permission_grant" }
  >,
  status: ApprovalTimelineItemStatus,
  approvalStatus: ThreadEventItemApprovalStatus,
): void {
  switch (subject.kind) {
    case "command":
      appendApprovalItemEvent(deps, interaction, {
        type: "commandExecution",
        id: subject.itemId,
        command: subject.command,
        cwd: subject.cwd ?? "",
        status,
        approvalStatus,
      });
      return;
    case "file_change":
      appendApprovalItemEvent(deps, interaction, {
        type: "fileChange",
        id: subject.itemId,
        changes: [],
        status,
        approvalStatus,
      });
      return;
    default:
      return assertNever(
        subject,
        "Unsupported approval subject for timeline item",
      );
  }
}

function appendApprovalSubjectItemEventInTransaction(
  deps: PendingInteractionTimelineTransactionDeps,
  interaction: PendingInteraction,
  subject: Exclude<
    PendingInteractionApprovalSubject,
    { kind: "permission_grant" }
  >,
  status: ApprovalTimelineItemStatus,
  approvalStatus: ThreadEventItemApprovalStatus,
): void {
  switch (subject.kind) {
    case "command":
      appendApprovalItemEventInTransaction(deps, interaction, {
        type: "commandExecution",
        id: subject.itemId,
        command: subject.command,
        cwd: subject.cwd ?? "",
        status,
        approvalStatus,
      });
      return;
    case "file_change":
      appendApprovalItemEventInTransaction(deps, interaction, {
        type: "fileChange",
        id: subject.itemId,
        changes: [],
        status,
        approvalStatus,
      });
      return;
    default:
      return assertNever(
        subject,
        "Unsupported approval subject for timeline item",
      );
  }
}

function appendPermissionGrantLifecycleTimelineEvent(
  deps: Pick<AppDeps, "db" | "hub">,
  interaction: PendingInteraction,
  subject: PendingInteractionPermissionGrantApprovalSubject,
): void {
  switch (interaction.status) {
    case "pending":
    case "resolving":
    case "resolved":
    case "interrupted":
    case "expired":
      appendPermissionGrantTimelineEvent(deps, interaction, subject);
      return;
  }
}

function appendPermissionGrantLifecycleTimelineEventInTransaction(
  deps: PendingInteractionTimelineTransactionDeps,
  interaction: PendingInteraction,
  subject: PendingInteractionPermissionGrantApprovalSubject,
): void {
  switch (interaction.status) {
    case "pending":
    case "resolving":
    case "resolved":
    case "interrupted":
    case "expired":
      appendPermissionGrantTimelineEventInTransaction(
        deps,
        interaction,
        subject,
      );
      return;
  }
}

function appendItemLifecycleTimelineEvent(
  deps: Pick<AppDeps, "db" | "hub">,
  interaction: PendingInteraction,
  subject: Exclude<
    PendingInteractionApprovalSubject,
    { kind: "permission_grant" }
  >,
): void {
  switch (interaction.status) {
    case "pending":
      appendApprovalSubjectItemEvent(
        deps,
        interaction,
        subject,
        "pending",
        "waiting_for_approval",
      );
      return;
    case "resolving":
      return;
    case "resolved":
      if (interaction.resolution?.decision === "deny") {
        appendApprovalSubjectItemEvent(
          deps,
          interaction,
          subject,
          "interrupted",
          "denied",
        );
      }
      return;
    case "interrupted":
    case "expired":
      appendApprovalSubjectItemEvent(
        deps,
        interaction,
        subject,
        "interrupted",
        null,
      );
      return;
  }
}

function appendItemLifecycleTimelineEventInTransaction(
  deps: PendingInteractionTimelineTransactionDeps,
  interaction: PendingInteraction,
  subject: Exclude<
    PendingInteractionApprovalSubject,
    { kind: "permission_grant" }
  >,
): void {
  switch (interaction.status) {
    case "pending":
      appendApprovalSubjectItemEventInTransaction(
        deps,
        interaction,
        subject,
        "pending",
        "waiting_for_approval",
      );
      return;
    case "resolving":
      return;
    case "resolved":
      if (interaction.resolution?.decision === "deny") {
        appendApprovalSubjectItemEventInTransaction(
          deps,
          interaction,
          subject,
          "interrupted",
          "denied",
        );
      }
      return;
    case "interrupted":
    case "expired":
      appendApprovalSubjectItemEventInTransaction(
        deps,
        interaction,
        subject,
        "interrupted",
        null,
      );
      return;
  }
}

export function appendPendingInteractionTimelineEvent(
  deps: Pick<AppDeps, "db" | "hub">,
  interaction: PendingInteraction,
): void {
  const subject = interaction.payload.subject;
  switch (subject.kind) {
    case "permission_grant":
      appendPermissionGrantLifecycleTimelineEvent(deps, interaction, subject);
      return;
    case "command":
    case "file_change":
      appendItemLifecycleTimelineEvent(deps, interaction, subject);
      return;
    default:
      return assertNever(subject, "Unsupported approval subject for timeline");
  }
}

export function appendPendingInteractionTimelineEventInTransaction(
  deps: PendingInteractionTimelineTransactionDeps,
  interaction: PendingInteraction,
): void {
  const subject = interaction.payload.subject;
  switch (subject.kind) {
    case "permission_grant":
      appendPermissionGrantLifecycleTimelineEventInTransaction(
        deps,
        interaction,
        subject,
      );
      return;
    case "command":
    case "file_change":
      appendItemLifecycleTimelineEventInTransaction(deps, interaction, subject);
      return;
    default:
      return assertNever(subject, "Unsupported approval subject for timeline");
  }
}
