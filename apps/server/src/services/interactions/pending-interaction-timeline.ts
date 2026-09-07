import { assertNever } from "@bb/core-ui";
import type {
  ApprovalPendingInteraction,
  PendingInteraction,
  PendingInteractionApprovalSubject,
  ThreadEventItemApprovalStatus,
  ThreadEventItem,
  ThreadEventScope,
} from "@bb/domain";
import {
  isApprovalPendingInteraction,
  toInteractionLifecycle,
  turnScope,
  threadScope,
} from "@bb/domain";
import {
  getThread,
  type AppendStoredThreadEventArgs,
  type DbNotifier,
  type DbTransaction,
} from "@bb/db";
import type { AppDeps } from "../../types.js";
import {
  appendThreadEvent,
  appendThreadEventInTransaction,
} from "../threads/thread-events.js";

interface PendingInteractionTimelineTransactionDeps {
  db: DbTransaction;
  hub: DbNotifier;
}

const INTERACTION_LIFECYCLE_EVENT_TYPE =
  "system/interaction/lifecycle" as const;

type ApprovalTimelineItem = Extract<
  ThreadEventItem,
  { type: "commandExecution" | "fileChange" }
>;
type ApprovalTimelineItemSubject = Extract<
  PendingInteractionApprovalSubject,
  { kind: "command" | "file_change" }
>;
type ApprovalTimelineItemStatus = Extract<
  ApprovalTimelineItem["status"],
  "pending" | "interrupted"
>;

function interactionScope(interaction: PendingInteraction): ThreadEventScope {
  return interaction.turnId === null
    ? threadScope()
    : turnScope(interaction.turnId);
}

function buildApprovalItem(
  subject: ApprovalTimelineItemSubject,
  status: ApprovalTimelineItemStatus,
  approvalStatus: ThreadEventItemApprovalStatus,
): ApprovalTimelineItem {
  switch (subject.kind) {
    case "command":
      return {
        type: "commandExecution",
        id: subject.itemId,
        command: subject.command,
        cwd: subject.cwd ?? "",
        status,
        approvalStatus,
      };
    case "file_change":
      return {
        type: "fileChange",
        id: subject.itemId,
        changes: [],
        status,
        approvalStatus,
      };
    default:
      return assertNever(
        subject,
        "Unsupported approval subject for timeline item",
      );
  }
}

function approvalItemWrite(
  interaction: ApprovalPendingInteraction,
  subject: ApprovalTimelineItemSubject,
): ApprovalTimelineItem | null {
  switch (interaction.status) {
    case "pending":
      return buildApprovalItem(subject, "pending", "waiting_for_approval");
    case "resolving":
      return null;
    case "resolved":
      return interaction.resolution?.decision === "deny"
        ? buildApprovalItem(subject, "interrupted", "denied")
        : null;
    case "interrupted":
      return buildApprovalItem(subject, "interrupted", null);
    default:
      return assertNever(interaction.status);
  }
}

function approvalItemSubject(
  interaction: ApprovalPendingInteraction,
): ApprovalTimelineItemSubject | null {
  const subject = interaction.payload.subject;
  switch (subject.kind) {
    case "command":
    case "file_change":
      return subject;
    case "permission_grant":
    case "plan":
    case "tool_use":
      return null;
    default:
      return assertNever(subject, "Unsupported approval subject for timeline");
  }
}

function approvalItemWriteFor(interaction: PendingInteraction): {
  interaction: ApprovalPendingInteraction;
  item: ApprovalTimelineItem;
} | null {
  if (!isApprovalPendingInteraction(interaction)) {
    return null;
  }
  const subject = approvalItemSubject(interaction);
  if (subject === null) {
    return null;
  }
  const item = approvalItemWrite(interaction, subject);
  return item === null ? null : { interaction, item };
}

function buildPendingInteractionTimelineWrites(
  db: Pick<AppDeps, "db">["db"] | DbTransaction,
  interaction: PendingInteraction,
): AppendStoredThreadEventArgs[] {
  const environmentId =
    getThread(db, interaction.threadId)?.environmentId ?? null;
  const writes: AppendStoredThreadEventArgs[] = [
    {
      threadId: interaction.threadId,
      environmentId,
      type: INTERACTION_LIFECYCLE_EVENT_TYPE,
      scope: interactionScope(interaction),
      data: { interaction: toInteractionLifecycle(interaction) },
    },
  ];
  const write = approvalItemWriteFor(interaction);
  if (write !== null) {
    const { providerThreadId, turnId } = write.interaction;
    writes.push({
      threadId: interaction.threadId,
      environmentId,
      type: write.item.status === "pending" ? "item/started" : "item/completed",
      providerThreadId,
      scope: turnScope(turnId),
      data: { providerThreadId, item: write.item },
    });
  }
  return writes;
}

export function appendPendingInteractionTimelineEvent(
  deps: Pick<AppDeps, "db" | "hub">,
  interaction: PendingInteraction,
): void {
  for (const write of buildPendingInteractionTimelineWrites(
    deps.db,
    interaction,
  )) {
    appendThreadEvent(deps, write);
  }
}

export function appendPendingInteractionTimelineEventInTransaction(
  deps: PendingInteractionTimelineTransactionDeps,
  interaction: PendingInteraction,
): void {
  const writes = buildPendingInteractionTimelineWrites(deps.db, interaction);
  for (const write of writes) {
    appendThreadEventInTransaction(deps.db, write);
  }
  deps.hub.notifyThread(interaction.threadId, ["events-appended"], {
    eventTypes: writes.map((write) => write.type),
  });
}
