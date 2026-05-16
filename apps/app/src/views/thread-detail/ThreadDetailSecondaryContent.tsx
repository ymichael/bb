import { type ComponentProps, type ReactNode } from "react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { ResponsiveDrawerShell } from "@/components/ui/responsive-overlay.js";
import { useIsCompactViewport } from "@/components/ui/hooks/use-compact-viewport.js";
import { Skeleton } from "@/components/ui/skeleton.js";
import { useAtomValue } from "jotai";
import {
  MAX_TERMINAL_PANEL_HEIGHT_PERCENT,
  MIN_TERMINAL_PANEL_HEIGHT_PERCENT,
} from "@/lib/thread-terminal-panel-state";
import { cn } from "@/lib/utils";
import { ThreadSecondaryPanel } from "@/components/secondary-panel/ThreadSecondaryPanel";
import { secondaryPanelWidthPercentAtom } from "@/components/secondary-panel/threadSecondaryPanelAtoms";
import {
  ThreadMetadataCard,
  ThreadMetadataContent,
  hasAnyThreadMetadata,
  type ThreadMetadataContentProps,
} from "@/components/secondary-panel/ThreadMetadataContent";
import { ThreadTimelinePane } from "./ThreadTimelinePane";

const CLOSED_TIMELINE_PANEL_SIZE_PERCENT = 100;

type ThreadTimelinePaneProps = Omit<
  ComponentProps<typeof ThreadTimelinePane>,
  "footer" | "header"
>;
type ThreadSecondaryPanelProps = Omit<
  ComponentProps<typeof ThreadSecondaryPanel>,
  "metadataContent" | "renderAsDrawer"
>;

interface ThreadDetailSecondaryContentProps {
  footer: ReactNode;
  header: ReactNode;
  isMetadataLoading: boolean;
  isSecondaryPanelOpen: boolean;
  metadata: ThreadMetadataContentProps;
  secondaryPanel: ThreadSecondaryPanelProps;
  terminalPanel?: ReactNode;
  terminalPanelHeightPercent: number;
  terminalPanelOpen: boolean;
  onTerminalPanelResize: (sizePercent: number) => void;
  timeline: ThreadTimelinePaneProps;
}

export function ThreadDetailSecondaryContent({
  footer,
  header,
  isMetadataLoading,
  isSecondaryPanelOpen,
  metadata,
  onTerminalPanelResize,
  secondaryPanel,
  terminalPanel,
  terminalPanelHeightPercent,
  terminalPanelOpen,
  timeline,
}: ThreadDetailSecondaryContentProps) {
  const renderAsDrawer = useIsCompactViewport();
  const persistedSecondaryWidthPercent = useAtomValue(
    secondaryPanelWidthPercentAtom,
  );

  const metadataContent = hasAnyThreadMetadata(metadata) ? (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <ThreadMetadataContent {...metadata} />
    </div>
  ) : isMetadataLoading ? (
    <ThreadMetadataLoadingSkeleton />
  ) : (
    <div className="pt-1 text-sm text-muted-foreground">
      No thread details available.
    </div>
  );
  const inlineSecondaryPanelContent = !renderAsDrawer ? (
    <ThreadSecondaryPanel
      {...secondaryPanel}
      renderAsDrawer={false}
      metadataContent={metadataContent}
    />
  ) : null;
  const drawerSecondaryPanelContent = renderAsDrawer ? (
    <ThreadSecondaryPanel
      {...secondaryPanel}
      renderAsDrawer={true}
      metadataContent={metadataContent}
    />
  ) : null;

  return (
    <div className="-mx-4 -mb-4 -mt-4 flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden md:-mx-5 md:-mb-5 md:-mt-5">
      <PanelGroup
        direction="vertical"
        className="h-full w-full min-w-0"
      >
        <Panel
          id="thread-detail-main-panel"
          defaultSize={
            terminalPanelOpen ? 100 - terminalPanelHeightPercent : 100
          }
          minSize={30}
          order={1}
          className="min-w-0 overflow-hidden"
        >
          <PanelGroup
            direction="horizontal"
            className="h-full w-full min-w-0"
          >
            <Panel
              id="thread-detail-timeline-panel"
              defaultSize={
                isSecondaryPanelOpen && !renderAsDrawer
                  ? 100 - persistedSecondaryWidthPercent
                  : CLOSED_TIMELINE_PANEL_SIZE_PERCENT
              }
              minSize={30}
              order={1}
              className="min-w-0 overflow-hidden"
            >
              <ThreadTimelinePane {...timeline} footer={footer} header={header} />
            </Panel>
            {inlineSecondaryPanelContent}
          </PanelGroup>
        </Panel>
        {terminalPanelOpen && terminalPanel ? (
          <>
            <TerminalPanelResizeHandle />
            <Panel
              id="thread-detail-terminal-panel"
              defaultSize={terminalPanelHeightPercent}
              minSize={MIN_TERMINAL_PANEL_HEIGHT_PERCENT}
              maxSize={MAX_TERMINAL_PANEL_HEIGHT_PERCENT}
              order={2}
              onResize={onTerminalPanelResize}
              className="min-h-0 min-w-0 overflow-hidden"
            >
              {terminalPanel}
            </Panel>
          </>
        ) : null}
      </PanelGroup>
      {renderAsDrawer ? (
        <ResponsiveDrawerShell
          open={isSecondaryPanelOpen}
          onOpenChange={(open) => {
            if (!open) secondaryPanel.onClose();
          }}
          srLabel="Thread details"
          contentClassName="h-[92dvh] max-h-[92dvh]"
          // `handleOnly` keeps vaul from binding its pointerdown handler on
          // the drawer body. Without it, vaul calls setPointerCapture on the
          // click target, which captures the pointer on Pierre tree's host
          // element and prevents the click from reaching rows inside the
          // shadow DOM. The drag handle bar still drags the drawer.
          handleOnly
        >
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            {drawerSecondaryPanelContent}
          </div>
        </ResponsiveDrawerShell>
      ) : null}
    </div>
  );
}

function TerminalPanelResizeHandle() {
  return (
    <PanelResizeHandle
      id="thread-detail-terminal-panel-handle"
      className={cn(
        "group relative h-px shrink-0 cursor-row-resize bg-border/70",
        "before:absolute before:-inset-y-1.5 before:inset-x-0 before:content-['']",
      )}
      aria-label="Resize thread and terminal panels"
    >
      <span className="pointer-events-none absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-border/70 transition-colors group-hover:bg-accent-foreground/35" />
    </PanelResizeHandle>
  );
}

const METADATA_SKELETON_ROW_VALUE_WIDTHS = ["w-40", "w-28", "w-36", "w-24"];

function ThreadMetadataLoadingSkeleton() {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <ThreadMetadataCard hasFlexibleHeight={false}>
        {METADATA_SKELETON_ROW_VALUE_WIDTHS.map((valueWidth, index) => (
          <div
            key={index}
            className="grid grid-cols-[var(--detail-label-width,96px)_minmax(0,1fr)] items-center gap-x-3 py-0.5"
          >
            <Skeleton className="h-3 w-14 rounded-sm" />
            <Skeleton className={`h-3 ${valueWidth} max-w-full rounded-sm`} />
          </div>
        ))}
      </ThreadMetadataCard>
    </div>
  );
}
