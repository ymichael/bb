import { useCallback, type ReactNode } from "react";
import { PluginReplacementSlot } from "@/components/plugin/PluginReplacementSlot";
import { deprecatedOriginalAlias } from "@/lib/plugin-sdk-deprecated-aliases";
import { useSidebar } from "@/components/ui/sidebar.js";
import { useRouteState } from "@/hooks/useRouteState";
import type { ResolvedReplacement } from "@/lib/plugin-slot-resolvers";
import type { PluginThreadListSlot } from "@/lib/plugin-slots";
import { appToast } from "@/components/ui/app-toast";

const THREAD_LIST_SLOT_KIND = "threadList";

interface PluginThreadListProps {
  replacement: ResolvedReplacement<PluginThreadListSlot>;
  original: ReactNode;
  searchQuery: string;
  onNavigate: () => void;
}

export function PluginThreadList({
  replacement,
  original,
  searchQuery,
  onNavigate,
}: PluginThreadListProps) {
  const { projectId, threadId } = useRouteState();
  const { isCompactViewport } = useSidebar();
  const title =
    replacement.kind === "plugin" ? replacement.registration.title : "Plugin";

  const handleCrash = useCallback(
    (pluginId: string) => {
      appToast.error("Sidebar plugin crashed", {
        description: `${title} (${pluginId}) stopped working, so bb's own thread list is back.`,
      });
    },
    [title],
  );

  return (
    <PluginReplacementSlot
      replacement={replacement}
      original={original}
      slotKind={THREAD_LIST_SLOT_KIND}
      onCrash={handleCrash}
    >
      {(slot, BoundOriginal) => (
        <slot.component
          activeThreadId={threadId ?? null}
          activeProjectId={projectId ?? null}
          isCompactViewport={isCompactViewport}
          onNavigate={onNavigate}
          searchQuery={searchQuery}
          Original={BoundOriginal}
          experimental_Original={deprecatedOriginalAlias(BoundOriginal)}
        />
      )}
    </PluginReplacementSlot>
  );
}
