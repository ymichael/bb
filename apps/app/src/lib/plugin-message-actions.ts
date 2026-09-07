import type {
  PluginMessageActionContext,
  ThreadChatMessageReference,
} from "@get-bb/plugin-sdk";
import type { MarkdownMessageDirectiveOpenThreadPanel } from "@/components/ui/markdown-message-directives";
import type { PluginMessageActionSlot } from "./plugin-slots";

interface RunPluginMessageActionArgs {
  slot: PluginMessageActionSlot;
  threadId: string;
  message: ThreadChatMessageReference;
  selectedText?: string;
  openThreadPanel: MarkdownMessageDirectiveOpenThreadPanel | undefined;
}

export function runPluginMessageAction({
  slot,
  threadId,
  message,
  selectedText,
  openThreadPanel,
}: RunPluginMessageActionArgs): void {
  const context: PluginMessageActionContext = {
    threadId,
    message,
    ...(selectedText !== undefined ? { selectedText } : {}),
    openPanel: (options) => {
      if (openThreadPanel === undefined) {
        console.warn(
          `[plugin:${slot.pluginId}] messageAction "${slot.id}" openPanel declined: this surface has no thread side panel`,
        );
        return false;
      }
      return openThreadPanel({ ...options, pluginId: slot.pluginId });
    },
  };
  const warn = (error: unknown) => {
    console.warn(
      `[plugin:${slot.pluginId}] messageAction "${slot.id}" failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  };
  try {
    const result = slot.run(context);
    if (result instanceof Promise) {
      result.catch(warn);
    }
  } catch (error) {
    warn(error);
  }
}
