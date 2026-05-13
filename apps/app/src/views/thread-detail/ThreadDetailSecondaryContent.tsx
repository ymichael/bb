import { type ComponentProps, type ReactNode, useEffect, useRef } from "react";
import { Panel, PanelGroup } from "react-resizable-panels";
import { ResponsiveDrawerShell } from "@/components/ui/responsive-overlay.js";
import { useIsCompactViewport } from "@/components/ui/hooks/use-compact-viewport.js";
import { useAtomValue } from "jotai";
import { useIsSecondaryPanelOpen } from "@/lib/thread-secondary-panel";
import { ThreadSecondaryPanel } from "@/components/secondary-panel/ThreadSecondaryPanel";
import { secondaryPanelWidthPercentAtom } from "@/components/secondary-panel/threadSecondaryPanelAtoms";
import {
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
  metadata: ThreadMetadataContentProps;
  secondaryPanel: ThreadSecondaryPanelProps;
  timeline: ThreadTimelinePaneProps;
}

export function ThreadDetailSecondaryContent({
  footer,
  header,
  metadata,
  secondaryPanel,
  timeline,
}: ThreadDetailSecondaryContentProps) {
  const renderAsDrawer = useIsCompactViewport();
  const isSecondaryPanelOpen = useIsSecondaryPanelOpen();
  const persistedSecondaryWidthPercent = useAtomValue(
    secondaryPanelWidthPercentAtom,
  );
  const didResetOnDrawerRef = useRef(false);
  const { onClose } = secondaryPanel;

  useEffect(() => {
    if (!renderAsDrawer) {
      didResetOnDrawerRef.current = false;
      return;
    }
    if (didResetOnDrawerRef.current) return;
    didResetOnDrawerRef.current = true;
    if (isSecondaryPanelOpen) {
      onClose();
    }
  }, [renderAsDrawer, isSecondaryPanelOpen, onClose]);

  const metadataContent = hasAnyThreadMetadata(metadata) ? (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <ThreadMetadataContent {...metadata} />
    </div>
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
