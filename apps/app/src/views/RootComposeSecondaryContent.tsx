import { useState, type ComponentProps, type ReactNode } from "react";
import { useIsCompactViewport } from "@bb/shared-ui/hooks/use-compact-viewport";
import { Skeleton } from "@bb/shared-ui/skeleton";
import { COARSE_POINTER_HEADER_ICON_BUTTON_CLASS } from "@bb/shared-ui/coarse-pointer-sizing";
import { cn } from "@bb/shared-ui/lib/utils";
import { PluginHomepageSections } from "@/components/plugin/PluginHomepageSections";
import { usePluginComposerHost } from "@/components/plugin/plugin-composer-host";
import { SecondaryPanelLayout } from "@/components/secondary-panel/SecondaryPanelLayout";
import { LazyThreadSecondaryPanel } from "@/components/secondary-panel/lazySecondaryPanelComponents";
import { PAGE_SHELL_CONTENT_STYLE } from "@/components/ui/page-shell-content-style.js";
import {
  CHROME_ROW_HEIGHT_CLASS,
  getBbDesktopInfo,
  MACOS_APP_REGION_NO_DRAG_CLASS,
  MACOS_WINDOW_DRAG_CLASS,
  shouldUseMacosDesktopChrome,
} from "@/lib/bb-desktop";
import { RootComposeCompactHome } from "./RootComposeCompactHome";
import { useOptionalPaneContext } from "./thread-detail/PaneContext";
import { getCompactPanelPresentation } from "@/components/secondary-panel/panelToggleControlState";

const ROOT_COMPOSE_MAX_WIDTH_CLASS = "max-w-[760px]";

export const ROOT_COMPOSE_PINNED_PANEL_TOGGLE_POSITION_CLASS =
  "right-[calc(1rem+env(safe-area-inset-right))] top-[calc(0.625rem+env(safe-area-inset-top))] max-md:pointer-coarse:top-[calc(0.375rem+env(safe-area-inset-top))]";

type RootSecondaryPanelProps = Omit<
  ComponentProps<typeof LazyThreadSecondaryPanel>,
  | "renderBrowserDeck"
  | "drawerFallback"
  | "isConversationCollapsed"
  | "onToggleConversationCollapse"
  | "renderAsDrawer"
  | "showNewTabButton"
> & {
  renderBrowserDeck?: (args: {
    activeBrowserTabId: string | null;
    canHandleBrowserCommands: boolean;
    canShowNativeBrowserView: boolean;
    onNativeFocus: () => void;
  }) => ReactNode;
};

interface RootComposeSecondaryContentProps {
  children: ReactNode;
  compactScrollContent: ReactNode;
  contentClassName?: string;
  isSecondaryPanelOpen: boolean;
  onToggleSecondaryPanel: () => void;
  secondaryPanel: RootSecondaryPanelProps;
}

function DrawerPanelLoadingSkeleton() {
  return (
    <div
      data-testid="drawer-panel-loading-skeleton"
      className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden p-4"
    >
      <Skeleton className="h-8 w-40 rounded-md" />
      <Skeleton className="h-24 w-full rounded-md" />
      <Skeleton className="h-24 w-full rounded-md" />
    </div>
  );
}

export function RootComposeSecondaryContent({
  children,
  compactScrollContent,
  contentClassName,
  isSecondaryPanelOpen,
  onToggleSecondaryPanel,
  secondaryPanel,
}: RootComposeSecondaryContentProps) {
  const paneContext = useOptionalPaneContext();
  const secondaryPanelHost = paneContext?.secondaryPanelHost ?? null;
  const composerHost = usePluginComposerHost();
  const [desktopInfo] = useState(getBbDesktopInfo);
  const usesDesktopChrome = shouldUseMacosDesktopChrome(desktopInfo);
  const rendersWindowDragStrip =
    usesDesktopChrome && paneContext?.isTopRow !== false;
  const { renderBrowserDeck, ...threadSecondaryPanelProps } = secondaryPanel;
  const isCompactViewport = useIsCompactViewport();
  const usesCompactHomeLayout =
    isCompactViewport && compactScrollContent !== null;

  const mainContent = (
    <div className="relative flex h-full min-h-0 flex-1 flex-col overflow-hidden">
      {rendersWindowDragStrip ? (
        <div
          data-testid="root-compose-main-window-drag-strip"
          aria-hidden="true"
          className={cn(
            "absolute inset-x-0 top-0 z-10 shrink-0",
            CHROME_ROW_HEIGHT_CLASS,
            MACOS_WINDOW_DRAG_CLASS,
          )}
        >
          {!isSecondaryPanelOpen && secondaryPanelHost === null ? (
            <div
              data-testid="root-compose-drag-strip-toggle-cutout"
              className={cn(
                "absolute",
                ROOT_COMPOSE_PINNED_PANEL_TOGGLE_POSITION_CLASS,
                COARSE_POINTER_HEADER_ICON_BUTTON_CLASS,
                MACOS_APP_REGION_NO_DRAG_CLASS,
              )}
            />
          ) : null}
        </div>
      ) : null}
      {usesCompactHomeLayout ? (
        <div
          className="@container/page flex min-h-0 flex-1 flex-col"
          style={PAGE_SHELL_CONTENT_STYLE}
        >
          <RootComposeCompactHome composer={children}>
            {compactScrollContent}
            <PluginHomepageSections />
          </RootComposeCompactHome>
        </div>
      ) : (
        <div className="@container/page min-h-0 flex-1 overflow-y-auto">
          <div
            className={cn(
              "mx-auto flex w-full flex-col px-4 pb-4 pt-2",
              ROOT_COMPOSE_MAX_WIDTH_CLASS,
              contentClassName,
            )}
            style={PAGE_SHELL_CONTENT_STYLE}
          >
            {children}
            {compactScrollContent}
            <PluginHomepageSections />
          </div>
        </div>
      )}
    </div>
  );

  return (
    <div className="-mx-4 -mb-4 -mt-4 flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-clip md:-mx-5 md:-mb-5 md:-mt-5">
      <SecondaryPanelLayout
        open={isSecondaryPanelOpen}
        onToggle={onToggleSecondaryPanel}
        onClose={threadSecondaryPanelProps.onClose}
        resetKey="new-thread"
        contentKey="new-thread"
        drawerLabel="Right panel"
        drawerFallback={<DrawerPanelLoadingSkeleton />}
        mainPanelId="root-compose-main-panel"
        main={mainContent}
        composerHost={composerHost}
        compactPresentation={getCompactPanelPresentation(
          threadSecondaryPanelProps.activeTab?.kind,
          threadSecondaryPanelProps.fixedTabs[0]?.tab.kind ??
            threadSecondaryPanelProps.tabs.find(
              (tab) => tab.isHidden !== true,
            )?.tab.kind,
        )}
        renderPanel={({
          presentation,
          canShowNativeBrowserView,
          onToggleMainCollapse,
          resizablePanelId,
        }) => (
          <LazyThreadSecondaryPanel
            {...threadSecondaryPanelProps}
            drawerFallback={<DrawerPanelLoadingSkeleton />}
            renderBrowserDeck={(activeBrowserTabId, pane) =>
              renderBrowserDeck?.({
                activeBrowserTabId,
                canHandleBrowserCommands:
                  canShowNativeBrowserView && pane.isFocused,
                canShowNativeBrowserView,
                onNativeFocus: pane.onFocusPane,
              })
            }
            renderAsDrawer={presentation === "drawer"}
            isConversationCollapsed={false}
            onToggleConversationCollapse={onToggleMainCollapse}
            showNewTabButton
            resizablePanelId={resizablePanelId}
          />
        )}
      />
    </div>
  );
}
