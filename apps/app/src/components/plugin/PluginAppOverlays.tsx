import { memo } from "react";
import {
  usePluginSlots,
  type ExperimentalAppOverlaySlot,
} from "@/lib/plugin-slots";
import { PluginSlotMount } from "./PluginSlotMount";

const PluginAppOverlay = memo(function PluginAppOverlay({
  slot,
}: {
  slot: ExperimentalAppOverlaySlot;
}) {
  const Component = slot.component;
  return (
    <PluginSlotMount
      pluginId={slot.pluginId}
      slotKind="appOverlay"
      slotId={slot.id}
      crashFallback={null}
    >
      <Component />
    </PluginSlotMount>
  );
});

export function PluginAppOverlays() {
  const { appOverlays } = usePluginSlots();
  if (appOverlays.length === 0) return null;

  return (
    <div data-bb-plugin-app-overlays="" className="contents">
      {appOverlays.map((slot) => (
        <PluginAppOverlay
          key={`${slot.pluginId}/${slot.id}/${slot.generation}`}
          slot={slot}
        />
      ))}
    </div>
  );
}
