import { useIsCompactViewport } from "@bb/shared-ui/hooks/use-compact-viewport";
import { PluginSlotMount } from "./PluginSlotMount";
import { usePluginSlots } from "@/lib/plugin-slots";

export function PluginThreadHeaderActions({
  threadId,
  projectId,
}: {
  threadId: string;
  projectId: string;
}) {
  const { threadHeaderActions } = usePluginSlots();
  const isCompactViewport = useIsCompactViewport();

  if (threadHeaderActions.length === 0) return null;

  return (
    <>
      {threadHeaderActions.map((slot) => {
        const Component = slot.component;
        return (
          <PluginSlotMount
            key={`${slot.pluginId}/${slot.id}/${slot.generation}/${threadId}`}
            pluginId={slot.pluginId}
            slotKind="threadHeaderAction"
            slotId={slot.id}
            instanceId={threadId}
            crashFallback={null}
          >
            {}
            <span
              role="group"
              aria-label={slot.title}
              className="flex max-h-7 max-w-64 shrink-0 items-center"
            >
              <Component
                threadId={threadId}
                projectId={projectId}
                isCompactViewport={isCompactViewport}
              />
            </span>
          </PluginSlotMount>
        );
      })}
    </>
  );
}
