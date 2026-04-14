import {
  formatPendingInteractionPermissionResolutionMessage,
  assertNever,
} from "@bb/core-ui";
import type {
  PendingInteraction,
  PendingInteractionApprovalSubject,
  PendingInteractionPermissionGrantApprovalSubject,
  ThreadEventItemApprovalStatus,
  ThreadEventItem,
} from "@bb/domain";
import { getThread } from "@bb/db";
import type { AppDeps } from "../../types.js";
import { appendThreadEvent } from "../threads/thread-events.js";

type ApprovalTimelineItem = Extract<
  ThreadEventItem,
  { type: "commandExecution" | "fileChange" }
>;
type ApprovalTimelineItemStatus = Extract<
  ApprovalTimelineItem["status"],
  "pending" | "interrupted"
>;

function permissionGrantLifecycleMessage(
  interaction: PendingInteraction,
  subject: PendingInteractionPermissionGrantApprovalSubject,
): string {
  switch (interaction.status) {
    case "pending":
      return subject.toolName
        ? `Waiting for approval to grant ${subject.toolName}`
        : "Waiting for approval to grant permissions";
    case "resolving":
      return "Delivering user response to provider";
    case "resolved":
      if (interaction.resolution === null) {
        return "Interaction resolved";
      }
      return formatPendingInteractionPermissionResolutionMessage(interaction.resolution);
    case "interrupted":
      return interaction.statusReason ?? "Interaction interrupted";
    case "expired":
      return interaction.statusReason ?? "Interaction expired";
  }
}

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
    data: {
      status: interaction.status,
      message: permissionGrantLifecycleMessage(interaction, subject),
      interactionId: interaction.id,
      providerId: interaction.providerId,
      providerRequestId: interaction.providerRequestId,
      subject,
    },
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
    turnId: interaction.turnId,
    data: {
      providerThreadId: interaction.providerThreadId,
      turnId: interaction.turnId,
      item,
    },
  });
}

function appendApprovalSubjectItemEvent(
  deps: Pick<AppDeps, "db" | "hub">,
  interaction: PendingInteraction,
  subject: Exclude<PendingInteractionApprovalSubject, { kind: "permission_grant" }>,
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

function appendItemLifecycleTimelineEvent(
  deps: Pick<AppDeps, "db" | "hub">,
  interaction: PendingInteraction,
  subject: Exclude<PendingInteractionApprovalSubject, { kind: "permission_grant" }>,
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
