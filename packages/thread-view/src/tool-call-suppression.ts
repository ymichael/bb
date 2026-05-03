import type { ThreadEvent } from "@bb/domain";

const SUPPRESSED_TIMELINE_TOOL_NAMES = new Set([
  "TodoRead",
  "TodoWrite",
  "ToolSearch",
]);

export function shouldSuppressLowValueToolCall(decoded: ThreadEvent): boolean {
  if (
    (decoded.type !== "item/started" && decoded.type !== "item/completed") ||
    decoded.item.type !== "toolCall"
  ) {
    return false;
  }

  if (!SUPPRESSED_TIMELINE_TOOL_NAMES.has(decoded.item.tool)) {
    return false;
  }

  return (
    decoded.item.status === "pending" || decoded.item.status === "completed"
  );
}
