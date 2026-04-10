import {
  formatPendingInteractionCommandApprovalResolutionMessage,
  formatPendingInteractionFileChangeApprovalResolutionMessage,
  formatPendingInteractionPermissionResolutionMessage,
} from "@bb/core-ui";
import {
  type PendingInteraction,
} from "@bb/domain";
import { getThread } from "@bb/db";
import type { AppDeps } from "../../types.js";
import { appendThreadEvent } from "../threads/thread-events.js";

function toPendingInteractionOperationStatus(
  interaction: PendingInteraction,
): "completed" | "failed" | "started" {
  switch (interaction.status) {
    case "pending":
      return "started";
    case "resolved":
      return "completed";
    case "interrupted":
    case "expired":
      return "failed";
  }
}

export function formatPendingInteractionLifecycleMessage(
  interaction: PendingInteraction,
): string {
  switch (interaction.status) {
    case "pending": {
      switch (interaction.payload.kind) {
        case "command_approval":
          return interaction.payload.command
            ? `Awaiting approval for command: ${interaction.payload.command}`
            : "Awaiting command approval";
        case "file_change_approval":
          return interaction.payload.reason ?? "Awaiting file-change approval";
        case "permission_request":
          return interaction.payload.reason
            ?? (interaction.payload.toolName
              ? `Awaiting permission approval for ${interaction.payload.toolName}`
              : "Awaiting permission approval");
      }
      const exhaustivePayload: never = interaction.payload;
      throw new Error(`Unsupported pending interaction payload: ${String(exhaustivePayload)}`);
    }
    case "resolved":
      if (interaction.resolution === null) {
        return "Interaction resolved";
      }
      switch (interaction.resolution.kind) {
        case "command_approval":
          return formatPendingInteractionCommandApprovalResolutionMessage(
            interaction.resolution.decision,
          );
        case "file_change_approval":
          return formatPendingInteractionFileChangeApprovalResolutionMessage(
            interaction.resolution.decision,
          );
        case "permission_request":
          return formatPendingInteractionPermissionResolutionMessage(
            interaction.resolution,
          );
      }
      const exhaustiveResolution: never = interaction.resolution;
      throw new Error(
        `Unsupported pending interaction resolution: ${String(exhaustiveResolution)}`,
      );
    case "interrupted":
      return interaction.statusReason ?? "Interaction interrupted";
    case "expired":
      return interaction.statusReason ?? "Interaction expired";
  }

  const exhaustiveStatus: never = interaction.status;
  throw new Error(`Unsupported pending interaction status: ${String(exhaustiveStatus)}`);
}

export function appendPendingInteractionTimelineEvent(
  deps: Pick<AppDeps, "db" | "hub">,
  interaction: PendingInteraction,
): void {
  const thread = getThread(deps.db, interaction.threadId);

  appendThreadEvent(deps, {
    threadId: interaction.threadId,
    environmentId: thread?.environmentId ?? null,
    type: "system/operation",
    data: {
      operation: interaction.payload.kind,
      status: toPendingInteractionOperationStatus(interaction),
      operationId: interaction.id,
      message: formatPendingInteractionLifecycleMessage(interaction),
      metadata: {
        interactionId: interaction.id,
        providerId: interaction.providerId,
        providerRequestId: interaction.providerRequestId,
      },
    },
  });
}
