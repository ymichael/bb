import { useCallback, useMemo, useSyncExternalStore } from "react";
import type { JsonValue } from "@bb/domain";
import type {
  PluginTimelineRendererProps,
  PluginTimelineRendererRow,
} from "@get-bb/plugin-sdk";
import type { TimelineViewWorkRow } from "@bb/thread-view";
import { PluginSlotMount } from "../../plugin/PluginSlotMount.js";
import {
  EMPTY_PLUGIN_SLOT_SNAPSHOT,
  getPluginSlotSnapshot,
  subscribePluginSlots,
  type PluginTimelineRendererSlot,
} from "@/lib/plugin-slots";
import { resolveTimelineRenderer } from "@/lib/plugin-slot-resolvers";
import { useThreadProvider } from "../thread-provider-context.js";

export type PluginRenderableWorkRow = Extract<
  TimelineViewWorkRow,
  { workKind: "extension" | "tool" }
>;

export function isPluginRenderableWorkRow(
  row: TimelineViewWorkRow,
): row is PluginRenderableWorkRow {
  return row.workKind === "extension" || row.workKind === "tool";
}

function useTimelineRendererSlots(): readonly PluginTimelineRendererSlot[] {
  return useSyncExternalStore(
    subscribePluginSlots,
    () => getPluginSlotSnapshot().timelineRenderers,
    () => EMPTY_PLUGIN_SLOT_SNAPSHOT.timelineRenderers,
  );
}

export function usePluginTimelineRenderer(
  row: TimelineViewWorkRow | null,
): PluginTimelineRendererSlot | null {
  const slots = useTimelineRendererSlots();
  const { pluginId: providerPluginId } = useThreadProvider();
  return useMemo(() => {
    if (row === null || slots.length === 0 || !isPluginRenderableWorkRow(row)) {
      return null;
    }
    return resolveTimelineRenderer(
      slots,
      row.workKind === "extension"
        ? { kind: "extension", extensionKind: row.extensionKind }
        : { kind: "tool", providerPluginId },
    );
  }, [providerPluginId, row, slots]);
}

function rendererRow(row: PluginRenderableWorkRow): PluginTimelineRendererRow {
  return {
    id: row.id,
    threadId: row.threadId,
    turnId: row.turnId,
    kind: row.workKind === "extension" ? row.extensionKind : "tool",
    toolName: row.workKind === "tool" ? row.toolName : null,
    status: row.status,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
  };
}

function rendererPayload(row: PluginRenderableWorkRow): JsonValue {
  if (row.workKind === "extension") {
    return row.payload;
  }
  return { arguments: row.toolArgs, output: row.output };
}

interface PluginTimelineRendererBodyProps {
  row: PluginRenderableWorkRow;
  slot: PluginTimelineRendererSlot;
  original: () => React.ReactElement | null;
}

export function PluginTimelineRendererBody({
  row,
  slot,
  original,
}: PluginTimelineRendererBodyProps) {
  const { providerId } = useThreadProvider();
  const Original = useCallback(() => original(), [original]);
  const props: PluginTimelineRendererProps = {
    row: rendererRow(row),
    payload: rendererPayload(row),
    presentation: row.presentation ?? null,
    thread: { id: row.threadId, providerId },
    Original,
  };
  return (
    <PluginSlotMount
      pluginId={slot.pluginId}
      slotKind="timelineRenderer"
      slotId={slot.kind}
      instanceId={row.id}
      crashFallback={original()}
    >
      <slot.component {...props} />
    </PluginSlotMount>
  );
}
