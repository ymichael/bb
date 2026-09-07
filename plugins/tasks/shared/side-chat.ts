const SIDE_CHAT_PLUGIN_ID = "side-chat";

interface SideChatShapeThread {
  originKind: string | null;
  originPluginId: string | null;
  visibility: string;
}

export function isSideChatShapedThread(thread: SideChatShapeThread): boolean {
  return (
    thread.originKind === "fork" &&
    thread.originPluginId === SIDE_CHAT_PLUGIN_ID &&
    thread.visibility === "hidden"
  );
}
