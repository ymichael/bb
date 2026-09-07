import { useMemo } from "react";
import type {
  PluginSidebarSplitPane,
  PluginSidebarThreadSplit,
} from "@get-bb/plugin-sdk";
import { usePaneContentSplitIndicator } from "@/components/sidebar/paneContentSplitIndicator";
import { useThreadRowSplitDrag } from "@/components/sidebar/useThreadRowSplitDrag";
import { getThreadDisplayTitle } from "./thread-title";
import { useSidebarThreadEntry } from "./plugin-sidebar-hooks";
import type { PaneContent } from "./split-layout";

const NO_SPLIT: PluginSidebarThreadSplit = {
  splitProps: {},
  isAvailable: false,
  layout: null,
};

export function useSidebarThreadSplit(
  threadId: string,
): PluginSidebarThreadSplit {
  const entry = useSidebarThreadEntry(threadId);
  const projectId = entry?.projectId ?? "";
  const title = entry ? getThreadDisplayTitle(entry) : "";
  const { onPointerDown } = useThreadRowSplitDrag({
    projectId,
    threadId,
    title,
  });
  const content = useMemo<PaneContent>(
    () => ({ kind: "thread", projectId, threadId }),
    [projectId, threadId],
  );
  const indicator = usePaneContentSplitIndicator(content, entry !== null);

  return useMemo<PluginSidebarThreadSplit>(() => {
    if (entry === null) return NO_SPLIT;
    const panes: PluginSidebarSplitPane[] | null =
      indicator.miniMap === null
        ? null
        : indicator.miniMap.map((slot) => ({
            paneId: slot.paneId,
            rect: {
              x: slot.rect.x,
              y: slot.rect.y,
              width: slot.rect.w,
              height: slot.rect.h,
            },
            isMe: slot.isMe,
            isFocused: slot.isFocused,
          }));
    return {
      splitProps: onPointerDown ? { onPointerDown } : {},
      isAvailable: onPointerDown !== undefined,
      layout: panes === null ? null : { panes },
    };
  }, [entry, indicator.miniMap, onPointerDown]);
}
