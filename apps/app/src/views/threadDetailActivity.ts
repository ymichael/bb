import { assertNever } from "@bb/core-ui";
import type { TimelineRow, ViewMessage } from "@bb/domain";

function isProvisioningActivityOperation(
  message: Extract<ViewMessage, { kind: "operation" }>,
): boolean {
  switch (message.opType) {
    case "provisioning":
      return true;
    default:
      // opType is stringly/open_external at the UI boundary; unknown values are intentionally not highlighted.
      return false;
  }
}

function isActivityMessage(message: ViewMessage): boolean {
  return (
    message.kind === "tool-call" ||
    message.kind === "file-edit" ||
    message.kind === "tool-exploring" ||
    message.kind === "web-search" ||
    message.kind === "error" ||
    (message.kind === "operation" && isProvisioningActivityOperation(message))
  );
}

function isActivityRow(row: TimelineRow): boolean {
  if (row.kind === "tool-group") return true;
  return isActivityMessage(row.message);
}

function shouldPreferOngoingLabelsForMessage(message: ViewMessage): boolean {
  switch (message.kind) {
    case "tool-call":
    case "tool-exploring":
    case "web-search":
    case "file-edit":
      return message.status === "completed";
    case "assistant-reasoning":
    case "assistant-text":
    case "user":
    case "operation":
    case "error":
    case "debug/raw-event":
      return false;
    default:
      return assertNever(message);
  }
}

export function findLatestActivityRowId(rows: TimelineRow[]): string | null {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (!row) continue;
    if (isActivityRow(row)) return row.id;
  }
  return null;
}

export function shouldHighlightLatestActivity(
  rows: TimelineRow[],
  latestActivityRowId: string | null,
): boolean {
  if (!latestActivityRowId) return false;
  const lastRow = rows[rows.length - 1];
  return Boolean(lastRow && lastRow.id === latestActivityRowId);
}

export function shouldPreferOngoingLabelsForRow(
  row: TimelineRow,
  latestActivityRowId: string | null,
): boolean {
  if (row.id !== latestActivityRowId) return false;

  switch (row.kind) {
    case "message":
      return shouldPreferOngoingLabelsForMessage(row.message);
    case "tool-group": {
      const latestActivityMessageId = findLatestActivityMessageId(row.messages);
      if (!latestActivityMessageId) return false;
      const latestActivityMessage = row.messages.find(
        (message) => message.id === latestActivityMessageId,
      );
      if (!latestActivityMessage) return false;
      return shouldPreferOngoingLabelsForMessage(latestActivityMessage);
    }
    default:
      return assertNever(row);
  }
}

export function findLatestActivityMessageId(messages: ViewMessage[]): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message) continue;
    if (isActivityMessage(message)) return message.id;
  }
  return null;
}
