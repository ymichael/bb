import type { SenderThreadMetadata } from "@/hooks/useSenderThreadMetadataById";

export const SIDE_CHAT_PLUGIN_ID = "side-chat";

export const SIDE_CHAT_PLUGIN_PANEL_ACTION_ID = "side-chat";

export function isPluginSideChatSenderThread(
  metadata: SenderThreadMetadata | null,
): boolean {
  return (
    metadata !== null &&
    metadata.originKind === "fork" &&
    metadata.originPluginId === SIDE_CHAT_PLUGIN_ID &&
    metadata.visibility === "hidden"
  );
}
