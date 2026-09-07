import type { ThreadEvent } from "@bb/domain";

export function shouldSuppressLowValueToolCall(decoded: ThreadEvent): boolean {
  if (decoded.type !== "item/started" && decoded.type !== "item/completed") {
    return false;
  }
  const item = decoded.item;
  switch (item.type) {
    case "toolCall":
    case "fileRead":
    case "search":
    case "planSteps":
    case "extension":
    case "delegation":
    case "fileChange":
      if (item.presentation?.suppress !== true) {
        return false;
      }
      return item.status === "pending" || item.status === "completed";
    default:
      return false;
  }
}
