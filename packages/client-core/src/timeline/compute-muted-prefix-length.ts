import type { TimelineUserConversationRow } from "@bb/server-contract";

export function computeMutedPrefixLength(
  initiator: TimelineUserConversationRow["initiator"],
  text: string,
): number {
  if (initiator === "user") return 0;
  if (!text.startsWith("[bb")) return 0;
  const closeIdx = text.indexOf("]");
  if (closeIdx === -1) return 0;
  let endIdx = closeIdx + 1;
  while (endIdx < text.length && /\s/.test(text.charAt(endIdx))) {
    endIdx += 1;
  }
  return endIdx;
}
