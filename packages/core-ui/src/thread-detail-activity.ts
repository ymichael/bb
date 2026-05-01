import type { TimelineRow, ViewMessage } from "@bb/domain";
import { assertNever } from "./assert-never.js";

export interface TimelineRowActivityInfo {
  containsLatestActivity: boolean;
  shouldPreferOngoingLabels: boolean;
}

function isProvisioningActivityOperation(
  message: Extract<ViewMessage, { kind: "operation" }>,
): boolean {
  switch (message.opType) {
    case "thread-provisioning":
      return true;
    default:
      return false;
  }
}

function isActivityMessage(message: ViewMessage): boolean {
  return (
    message.kind === "command" ||
    message.kind === "tool-call" ||
    message.kind === "delegation" ||
    message.kind === "file-edit" ||
    message.kind === "tasks" ||
    message.kind === "web-search" ||
    message.kind === "web-fetch" ||
    message.kind === "permission-grant-lifecycle" ||
    message.kind === "error" ||
    (message.kind === "operation" && isProvisioningActivityOperation(message))
  );
}

function isActivityRow(row: TimelineRow): boolean {
  switch (row.kind) {
    case "message":
      return isActivityMessage(row.message);
    case "tool-bundle":
      return true;
    case "assistant-step-summary":
      return row.rows.some(isActivityRow);
    case "turn-summary":
      return row.rows?.some(isActivityRow) ?? true;
    default:
      return assertNever(row);
  }
}

function shouldPreferOngoingLabelsForMessage(message: ViewMessage): boolean {
  switch (message.kind) {
    case "command":
    case "tool-call":
    case "delegation":
    case "web-search":
    case "web-fetch":
    case "file-edit":
    case "permission-grant-lifecycle":
      return message.status === "completed";
    case "tasks":
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

function findLatestActivityRowIdInRow(row: TimelineRow): string | null {
  switch (row.kind) {
    case "message":
      return isActivityMessage(row.message) ? row.id : null;
    case "tool-bundle": {
      for (let index = row.rows.length - 1; index >= 0; index -= 1) {
        const childRow = row.rows[index];
        if (!childRow) {
          continue;
        }
        const childActivityRowId = findLatestActivityRowIdInRow(childRow);
        if (childActivityRowId) {
          return childActivityRowId;
        }
      }
      return row.id;
    }
    case "assistant-step-summary": {
      for (let index = row.rows.length - 1; index >= 0; index -= 1) {
        const childRow = row.rows[index];
        if (!childRow) {
          continue;
        }
        const childActivityRowId = findLatestActivityRowIdInRow(childRow);
        if (childActivityRowId) {
          return childActivityRowId;
        }
      }
      return null;
    }
    case "turn-summary": {
      if (!row.rows) {
        return row.id;
      }
      for (let index = row.rows.length - 1; index >= 0; index -= 1) {
        const childRow = row.rows[index];
        if (!childRow) {
          continue;
        }
        const childActivityRowId = findLatestActivityRowIdInRow(childRow);
        if (childActivityRowId) {
          return childActivityRowId;
        }
      }
      return row.id;
    }
    default:
      return assertNever(row);
  }
}

function rowContainsId(row: TimelineRow, targetId: string): boolean {
  if (row.id === targetId) {
    return true;
  }

  switch (row.kind) {
    case "message":
      return false;
    case "tool-bundle":
    case "assistant-step-summary":
      return row.rows.some((childRow) => rowContainsId(childRow, targetId));
    case "turn-summary":
      return (
        row.rows?.some((childRow) => rowContainsId(childRow, targetId)) ?? false
      );
    default:
      return assertNever(row);
  }
}

function buildTimelineRowActivityInfoForRow(
  row: TimelineRow,
  latestActivityRowId: string | null,
  infoById: Map<string, TimelineRowActivityInfo>,
): boolean {
  const containsLatestActivity = (() => {
    if (!latestActivityRowId) {
      return false;
    }
    if (row.id === latestActivityRowId) {
      return true;
    }

    switch (row.kind) {
      case "message":
        return false;
      case "tool-bundle":
      case "assistant-step-summary":
        return row.rows.some((childRow) =>
          buildTimelineRowActivityInfoForRow(
            childRow,
            latestActivityRowId,
            infoById,
          ),
        );
      case "turn-summary":
        return (
          row.rows?.some((childRow) =>
            buildTimelineRowActivityInfoForRow(
              childRow,
              latestActivityRowId,
              infoById,
            ),
          ) ?? false
        );
      default:
        return assertNever(row);
    }
  })();

  const shouldPreferOngoingLabels = containsLatestActivity
    ? row.kind === "message"
      ? shouldPreferOngoingLabelsForMessage(row.message)
      : row.status === "pending"
    : false;

  infoById.set(row.id, {
    containsLatestActivity,
    shouldPreferOngoingLabels,
  });

  return containsLatestActivity;
}

export function buildTimelineRowActivityInfoMap(
  rows: readonly TimelineRow[],
  latestActivityRowId: string | null,
): ReadonlyMap<string, TimelineRowActivityInfo> {
  const infoById = new Map<string, TimelineRowActivityInfo>();
  for (const row of rows) {
    buildTimelineRowActivityInfoForRow(row, latestActivityRowId, infoById);
  }
  return infoById;
}

export function findLatestActivityRowId(rows: TimelineRow[]): string | null {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (!row || !isActivityRow(row)) {
      continue;
    }
    return findLatestActivityRowIdInRow(row);
  }
  return null;
}

export function shouldHighlightLatestActivity(
  rows: TimelineRow[],
  latestActivityRowId: string | null,
): boolean {
  if (!latestActivityRowId) return false;
  const lastRow = rows[rows.length - 1];
  return Boolean(lastRow && rowContainsId(lastRow, latestActivityRowId));
}

export function shouldPreferOngoingLabelsForRow(
  row: TimelineRow,
  latestActivityRowId: string | null,
): boolean {
  return (
    buildTimelineRowActivityInfoMap([row], latestActivityRowId).get(row.id)
      ?.shouldPreferOngoingLabels ?? false
  );
}

export function findLatestActivityMessageId(
  messages: ViewMessage[],
): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message) continue;
    if (isActivityMessage(message)) return message.id;
  }
  return null;
}
