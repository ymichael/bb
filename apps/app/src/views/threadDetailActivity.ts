import {
  assertNever,
  type UIMessage,
} from "@bb/core";
import type { ThreadDetailRow } from "./threadDetailRows";

function isProvisioningActivityOperation(
  message: Extract<UIMessage, { kind: "operation" }>,
): boolean {
  switch (message.opType) {
    case "provisioning":
    case "provisioning-started":
    case "provisioning-progress":
    case "provisioning-env-setup":
    case "provisioning-fallback":
    case "provisioning-completed":
    case "provisioning-cleanup-failed":
      return true;
    default:
      // opType is stringly/open_external at the UI boundary; unknown values are intentionally not highlighted.
      return false;
  }
}

export function isActivityMessage(message: UIMessage): boolean {
  return (
    message.kind === "tool-call" ||
    message.kind === "file-edit" ||
    message.kind === "tool-exploring" ||
    message.kind === "web-search" ||
    message.kind === "error" ||
    (message.kind === "operation" && isProvisioningActivityOperation(message))
  );
}

export function isActivityRow(row: ThreadDetailRow): boolean {
  if (row.kind === "tool-group") return true;
  return isActivityMessage(row.message);
}

function shouldPreferOngoingLabelsForMessage(message: UIMessage): boolean {
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

export function findLatestActivityRowId(rows: ThreadDetailRow[]): string | null {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (!row) continue;
    if (isActivityRow(row)) return row.id;
  }
  return null;
}

export function shouldHighlightLatestActivity(
  rows: ThreadDetailRow[],
  latestActivityRowId: string | null,
): boolean {
  if (!latestActivityRowId) return false;
  const lastRow = rows[rows.length - 1];
  return Boolean(lastRow && lastRow.id === latestActivityRowId);
}

export function shouldPreferOngoingLabelsForRow(
  row: ThreadDetailRow,
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

export function findLatestActivityMessageId(messages: UIMessage[]): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message) continue;
    if (isActivityMessage(message)) return message.id;
  }
  return null;
}
