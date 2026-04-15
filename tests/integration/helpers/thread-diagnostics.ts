import type { ThreadEventRow } from "@bb/domain";

export function stringifyThreadEventData(
  event: ThreadEventRow | undefined,
): string {
  return JSON.stringify(event?.data ?? null);
}

export function previewThreadText(value: string | null): string {
  const normalized = (value ?? "").replace(/\s+/g, " ").trim();
  if (normalized.length <= 240) {
    return normalized;
  }
  return `${normalized.slice(0, 240)}...`;
}

export function describeThreadEvent(event: ThreadEventRow): string {
  if (event.type === "item/completed") {
    const item = event.data.item;
    if (item.type === "toolCall") {
      const error = item.error ? ` error=${item.error}` : "";
      return `${event.seq}:${event.type}:${item.type}:${item.tool}:${item.status}${error}`;
    }
    if (item.type === "commandExecution") {
      return `${event.seq}:${event.type}:${item.type}:${item.status}:${item.approvalStatus}`;
    }
    if (item.type === "fileChange") {
      return `${event.seq}:${event.type}:${item.type}:${item.status}:${item.approvalStatus}`;
    }
    return `${event.seq}:${event.type}:${item.type}`;
  }
  if (event.type === "item/started") {
    return `${event.seq}:${event.type}:${event.data.item.type}`;
  }
  if (event.type === "error" || event.type === "system/error") {
    const detail = event.data.detail ? ` ${event.data.detail}` : "";
    return `${event.seq}:${event.type}:${event.data.message}${detail}`;
  }
  return `${event.seq}:${event.type}`;
}
