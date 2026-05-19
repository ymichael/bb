import {
  useCallback,
  useEffect,
  useRef,
  type ComponentProps,
  type ReactNode,
} from "react";
import {
  Panel,
  PanelGroup,
  PanelResizeHandle,
  type ImperativePanelHandle,
} from "react-resizable-panels";
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
const TERMINAL_PANEL_TRANSITION_CLASS =
  "duration-[220ms] ease-[cubic-bezier(0.32,0.72,0,1)]";

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

  const terminalPanelRef = useRef<ImperativePanelHandle | null>(null);
  const lastTerminalSizeRef = useRef(terminalPanelHeightPercent);
  const didMountTerminalRef = useRef(false);

  useEffect(() => {
    // Skip initial mount — Panel's defaultSize handles it.
    if (!didMountTerminalRef.current) {
      didMountTerminalRef.current = true;
      return;
    }
    const panel = terminalPanelRef.current;
    if (!panel) {
      return;
    }
    if (terminalPanelOpen) {
      panel.expand(lastTerminalSizeRef.current);
    } else {
      panel.collapse();
    }
  }, [terminalPanelOpen]);

  const handleTerminalPanelResize = useCallback(
    (size: number) => {
      if (size <= 0) {
        return;
      }
      lastTerminalSizeRef.current = size;
      onTerminalPanelResize(size);
    },
    [onTerminalPanelResize],
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
        {terminalPanel ? (
          <>
            <TerminalPanelResizeHandle isOpen={terminalPanelOpen} />
            <Panel
              ref={terminalPanelRef}
              id="thread-detail-terminal-panel"
              collapsible
              collapsedSize={0}
              defaultSize={
                terminalPanelOpen ? terminalPanelHeightPercent : 0
              }
              minSize={MIN_TERMINAL_PANEL_HEIGHT_PERCENT}
              maxSize={MAX_TERMINAL_PANEL_HEIGHT_PERCENT}
              order={2}
              onResize={handleTerminalPanelResize}
              className={cn(
                "min-h-0 min-w-0 overflow-hidden transition-[flex-grow,flex-basis,opacity]",
                TERMINAL_PANEL_TRANSITION_CLASS,
                terminalPanelOpen ? "opacity-100" : "opacity-0",
              )}
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

function TerminalPanelResizeHandle({ isOpen }: { isOpen: boolean }) {
  return (
    <PanelResizeHandle
      id="thread-detail-terminal-panel-handle"
      disabled={!isOpen}
      className={cn(
        "group relative shrink-0 cursor-row-resize overflow-visible bg-transparent transition-[height,opacity,background-color]",
        TERMINAL_PANEL_TRANSITION_CLASS,
        "before:absolute before:-inset-y-1.5 before:inset-x-0 before:content-['']",
        isOpen ? "h-px opacity-100" : "pointer-events-none h-0 opacity-0",
      )}
      aria-label="Resize thread and terminal panels"
    >
      <span className="pointer-events-none absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-border transition-colors group-hover:bg-accent-foreground/35" />
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
