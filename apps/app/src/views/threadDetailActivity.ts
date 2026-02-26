import type { UIMessage } from "@beanbag/agent-core";
import type { ThreadDetailRow } from "./threadDetailRows";

export function isActivityMessage(message: UIMessage): boolean {
  return (
    message.kind === "tool-call" ||
    message.kind === "file-edit" ||
    message.kind === "tool-exploring" ||
    message.kind === "web-search" ||
    message.kind === "error"
  );
}

export function isActivityRow(row: ThreadDetailRow): boolean {
  if (row.kind === "tool-group") return true;
  return isActivityMessage(row.message);
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

export function findLatestActivityMessageId(messages: UIMessage[]): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message) continue;
    if (isActivityMessage(message)) return message.id;
  }
  return null;
}
