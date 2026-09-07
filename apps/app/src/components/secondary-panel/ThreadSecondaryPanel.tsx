import {
  type CSSProperties,
  type FocusEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type TransitionEvent,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useAtomValue } from "jotai";
import type { DiffFileEntry } from "@bb/server-contract";
import { Icon } from "@bb/shared-ui/icon";
import { EmptyStatePanel } from "@bb/shared-ui/empty-state";
import { Panel, PanelResizeHandle } from "react-resizable-panels";
import { Button } from "@bb/shared-ui/button";
import { HEADER_PANE_ACTION_ICON_BUTTON_CLASS } from "@/components/layout/AppPageHeader";
import { CHROME_SUBTLE_ICON_BUTTON_FOREGROUND_CLASS } from "@bb/shared-ui/chrome-style-tokens";
import {
  COARSE_POINTER_COMPACT_ICON_BUTTON_CLASS,
  COARSE_POINTER_HEADER_ICON_BUTTON_CLASS,
} from "@bb/shared-ui/coarse-pointer-sizing";
import { cn } from "@bb/shared-ui/lib/utils";
import {
  PANEL_COLLAPSE_TRANSITION_CLASS,
  PANEL_RESIZE_HIT_AREA_MARGINS,
  PANEL_RESIZE_HANDLE_LAYER_CLASS,
  PANEL_RESIZE_HIT_TARGET_CLASS,
} from "./panelTransitionTokens";
import { SECONDARY_PANEL_TOP_CHROME_BACKGROUND_CLASS } from "./panelChromeClasses";
import {
  CONVERSATION_COLLAPSED_PANEL_SIZE_PERCENT,
  THREAD_SECONDARY_PANEL_MAX_SIZE_PERCENT,
  THREAD_SECONDARY_PANEL_MIN_SIZE_PERCENT,
} from "./secondaryPanelSizing";
import {
  RIGHT_PANEL_TOGGLE_ICON_NAME,
  resolveConversationCollapseControl,
} from "./panelToggleControlState";
import { SecondaryPanelHostLayoutContext } from "./SecondaryPanelHostLayoutContext";
import { SecondaryPanelTabStrip } from "./SecondaryPanelTabStrip";
import type {
  MarketplacePluginDetailPanelTab,
  SecondaryPanelPaneRenderContext,
  SecondaryPanelRenderableTab,
  SecondaryPanelTabReorderHandler,
} from "./secondaryPanelTab";
import { useEnvironmentDiffFiles } from "@/hooks/queries/environment-queries";
import {
  DEFAULT_CODE_OVERFLOW_MODE,
  type CodeOverflowMode,
} from "@/lib/code-overflow-mode";
import type { DiffPresentation } from "@/components/code/code-rendering";
import { useGitDiffPanelState } from "./git-diff/useGitDiffPanelState";
import { useResponsiveGitDiffPanelDisplay } from "./git-diff/useResponsiveGitDiffPanelDisplay";
import {
  summarizeDiffFileEntries,
  useDiffFilesCollapseControls,
} from "./git-diff/diffFilesStore";
import { buildGitDiffIdentity } from "./git-diff/gitDiffPanelHelpers";
import {
  type SecondaryPanelDraggingHandler,
  useSecondaryPanelResize,
} from "./useSecondaryPanelResize";
import { threadSecondaryPanelResizingAtom } from "./threadSecondaryPanelAtoms";
import { GitDiffToolbar } from "./GitDiffToolbar";
import { GitDiffTabContent } from "./ThreadSecondaryPanelTabContent";
import {
  CHROME_ROW_CLASS,
  getBbDesktopInfo,
  MACOS_APP_REGION_NO_DRAG_CLASS,
  MACOS_CHROME_CONTROL_AXIS_CLASS,
  MACOS_COLLAPSED_TOP_LEFT_RESERVE_CLASS,
  MACOS_WINDOW_DRAG_CLASS,
  MACOS_WINDOW_NO_DRAG_CLASS,
  shouldReserveMacosTrafficLights,
  shouldUseMacosDesktopChrome,
} from "@/lib/bb-desktop";
import { useDesktopWindowState } from "@/hooks/useDesktopWindowState";
import { useOptionalIsSidebarShowing } from "@/components/ui/sidebar.js";
import { IframeDragGuardOverlay } from "@/lib/iframe-drag-guard";
import type {
  FixedPanelViewTab,
  SecondaryFixedPanelTab,
} from "@/lib/fixed-panel-tabs-state";
import { useAppCommandShortcut } from "@/components/commands/AppCommandProvider";
import { AppCommandShortcutHint } from "@/components/commands/AppCommandShortcutHint";
import type { AppShortcutPresentation } from "@/lib/app-keybindings";
import { TabPill } from "@/components/ui/tab-pill";
import { Tooltip, TooltipContent, TooltipTrigger } from "@bb/shared-ui/tooltip";
import { dispatchBrowserViewBoundsSync } from "@/lib/browser-view-bounds-sync";
import type { SplitSide } from "@/lib/split-layout";
import { PaneArrangementButton } from "@/views/thread-detail/PaneMaximizeButton";
import {
  SidebarSplitContainer,
  type SidebarSplitPaneRenderArgs,
  type SidebarSplitTabDescriptor,
} from "./SidebarSplitContainer";
import { SIDEBAR_FIXED_INFO_TAB_ID } from "./sidebarSplitLayout";
import type { GitDiffTabStatus } from "./gitDiffTabEligibility";
export type {
  SecondaryPanelPaneRenderContext,
  SecondaryPanelRenderableTab,
} from "./secondaryPanelTab";

export function isSecondaryPanelLayoutTransition(
  propertyName: string,
): boolean {
  return propertyName === "flex-grow" || propertyName === "flex-basis";
}
const PANEL_SCROLL_SLOT_CLASS =
  "min-h-0 flex-1 overflow-x-auto overflow-y-auto";
const SECONDARY_RESIZABLE_PANEL_STYLE: CSSProperties = {
  pointerEvents: "auto",
};
const SECONDARY_PANEL_CHROME_ICON_BUTTON_CLASS = `${COARSE_POINTER_COMPACT_ICON_BUTTON_CLASS} shrink-0 ${CHROME_SUBTLE_ICON_BUTTON_FOREGROUND_CLASS}`;
const SECONDARY_PANEL_HIDE_ICON_BUTTON_CLASS = `${COARSE_POINTER_HEADER_ICON_BUTTON_CLASS} shrink-0 ${CHROME_SUBTLE_ICON_BUTTON_FOREGROUND_CLASS}`;
const EMPTY_DIFF_FILES: readonly DiffFileEntry[] = [];

export function getReservedInlinePanelToggleClassName(
  usesDesktopChrome: boolean,
): string {
  return cn(
    SECONDARY_PANEL_HIDE_ICON_BUTTON_CLASS,
    usesDesktopChrome && MACOS_APP_REGION_NO_DRAG_CLASS,
  );
}

export function getSecondaryPanelChromeStackClassName(
  hasGitDiffToolbar: boolean,
): string {
  return cn(
    "shrink-0 select-none",
    hasGitDiffToolbar && "flex flex-col",
    SECONDARY_PANEL_TOP_CHROME_BACKGROUND_CLASS,
  );
}

interface CollapsedPanelTrafficLightReserveArgs {
  isConversationCollapsed: boolean;
  renderAsDrawer: boolean;
  isSidebarShowing: boolean | null;
  reserveMacosTrafficLights: boolean;
}

export function resolveCollapsedPanelTrafficLightReserveClassName({
  isConversationCollapsed,
  renderAsDrawer,
  isSidebarShowing,
  reserveMacosTrafficLights,
}: CollapsedPanelTrafficLightReserveArgs): string | false {
  const reserves =
    isConversationCollapsed &&
    !renderAsDrawer &&
    isSidebarShowing === false &&
    reserveMacosTrafficLights;
  return reserves && MACOS_COLLAPSED_TOP_LEFT_RESERVE_CLASS;
}

const HIDE_PANEL_LABEL = "Hide right panel";

export interface SecondaryPanelFixedTab {
  ariaLabel: string;
  contentFillsRegion?: boolean;
  label: string;
  leadingVisual: ReactNode;
  onSelect: () => void;
  renderContent?: (pane: SecondaryPanelPaneRenderContext) => ReactNode;
  tab: FixedPanelViewTab;
  title: string;
}

export interface ThreadSecondaryPanelProps {
  activeTab: SecondaryFixedPanelTab | MarketplacePluginDetailPanelTab | null;
  canUseGitUi: boolean;
  gitDiffTabStatus?: GitDiffTabStatus;
  onRetryGitDiffEligibility?: () => void;
  requestedMergeBaseBranch?: string;
  environmentId?: string;
  metadataContent: ReactNode;
  tabs: readonly SecondaryPanelRenderableTab[];
  fixedTabs: readonly SecondaryPanelFixedTab[];
  onTabReorder: SecondaryPanelTabReorderHandler;
  renderBrowserDeck?: (
    activeBrowserTabId: string | null,
    pane: SecondaryPanelPaneRenderContext,
  ) => ReactNode;
  splitPanelStateId?: string;
  isOpen: boolean;
  showConversationCollapseControl?: boolean;
  showNewTabButton?: boolean;
  inlinePanelToggle?: "button" | "reserved" | "hidden";
  resizablePanelId?: string;
  onPanelFocus: () => void;
  onCollapse: () => void;
  onClose: () => void;
  onClearPendingGitDiffIntent?: () => void;
  onOpenNewTab: () => void;
  pendingGitDiffCommitSha?: string | null;
  pendingGitDiffScrollPath?: string | null;
  workspaceRootPath?: string | null;
  onOpenFileInEditor?: (path: string) => void;
  onOpenFilePreview?: (path: string) => void;
  onSelectionAddToChat?: (text: string) => void;
  isConversationCollapsed: boolean;
  onToggleConversationCollapse: () => void;
  renderAsDrawer: boolean;
}

export function ThreadSecondaryPanel({
  activeTab,
  canUseGitUi,
  gitDiffTabStatus,
  requestedMergeBaseBranch,
  environmentId,
  metadataContent,
  tabs,
  fixedTabs,
  onTabReorder,
  renderBrowserDeck,
  splitPanelStateId,
  isOpen,
  showConversationCollapseControl = true,
  showNewTabButton = true,
  inlinePanelToggle = "button",
  resizablePanelId = "thread-detail-secondary-panel",
  onPanelFocus,
  onCollapse,
  onClose,
  onClearPendingGitDiffIntent,
  onOpenNewTab,
  onRetryGitDiffEligibility,
  pendingGitDiffCommitSha,
  pendingGitDiffScrollPath,
  workspaceRootPath,
  onOpenFileInEditor,
  onOpenFilePreview,
  onSelectionAddToChat,
  isConversationCollapsed,
  onToggleConversationCollapse,
  renderAsDrawer,
}: ThreadSecondaryPanelProps) {
  const resolvedGitDiffTabStatus =
    gitDiffTabStatus ?? (canUseGitUi ? "eligible" : "ineligible");
  const newTabShortcut = useAppCommandShortcut("panel.newTab");
  const togglePanelShortcut = useAppCommandShortcut("panel.toggle");
  const diffShortcut = useAppCommandShortcut("diff.toggle");
  const visibleTabs = useMemo(
    () => tabs.filter((tab) => tab.isHidden !== true),
    [tabs],
  );
  const activeRenderableTab =
    tabs.find((tab) => tab.tab.id === activeTab?.id) ??
    (activeTab === null && fixedTabs.length === 0 ? visibleTabs[0] : undefined);
  const hasActiveRenderableTab = activeRenderableTab !== undefined;
  const hidePanelIconName = RIGHT_PANEL_TOGGLE_ICON_NAME;
  const conversationCollapseControl =
    renderAsDrawer || !showConversationCollapseControl
      ? null
      : resolveConversationCollapseControl({
          isConversationCollapsed,
          onToggleConversationCollapse,
        });
  const {
    gitDiffDisplayMode,
    handleGitDiffDisplayModeChange,
    handleSecondaryPanelResizeStart,
    handleSecondaryPanelWidthChange,
  } = useResponsiveGitDiffPanelDisplay({ isSecondaryPanelOpen: isOpen });
  const {
    handleSecondaryPanelDragging: handleResizeDragging,
    handleSecondaryPanelResize,
    handleSecondaryPanelResizePointerDownCapture,
    persistedWidthPercent,
    secondaryPanelRef: panelRef,
    secondaryResizablePanelRef: resizablePanelRef,
  } = useSecondaryPanelResize({
    isSecondaryPanelOpen: isOpen,
    onPanelWidthChange: handleSecondaryPanelWidthChange,
  });
  const handleSecondaryPanelDragging: SecondaryPanelDraggingHandler =
    useCallback(
      (isDragging) => {
        if (isDragging) {
          handleSecondaryPanelResizeStart();
        }
        handleResizeDragging(isDragging);
      },
      [handleResizeDragging, handleSecondaryPanelResizeStart],
    );
  const hasPanelExpandedRef = useRef(false);
  useLayoutEffect(() => {
    hasPanelExpandedRef.current = false;
  }, [splitPanelStateId]);
  const handlePanelResize = useCallback(
    (size: number) => {
      if (size > 0) {
        hasPanelExpandedRef.current = true;
      }
      handleSecondaryPanelResize(size);
    },
    [handleSecondaryPanelResize],
  );
  const hostLayout = useContext(SecondaryPanelHostLayoutContext);
  const handlePanelCollapse = useCallback(() => {
    if (!isOpen || hostLayout?.isSuppressed) {
      return;
    }
    if (!hasPanelExpandedRef.current) {
      return;
    }
    hasPanelExpandedRef.current = false;
    onCollapse();
  }, [hostLayout?.isSuppressed, isOpen, onCollapse]);
  const handlePanelTransitionEnd = useCallback(
    (event: TransitionEvent<HTMLElement>) => {
      if (
        event.target !== event.currentTarget ||
        !isSecondaryPanelLayoutTransition(event.propertyName)
      ) {
        return;
      }

      dispatchBrowserViewBoundsSync();
    },
    [],
  );
  const isLayoutOpen =
    (hostLayout?.isOpen ?? isOpen) && !hostLayout?.isSuppressed;
  const activeFixedTab =
    fixedTabs.find((fixedTab) => fixedTab.tab.id === activeTab?.id) ??
    (!hasActiveRenderableTab ? fixedTabs[0] : undefined);
  const isDiffPanelActive =
    resolvedGitDiffTabStatus === "eligible" &&
    activeFixedTab?.tab.kind === "git-diff";
  const isDiffPanelLive = isDiffPanelActive && isLayoutOpen;
  const isDiffEligibilityPending =
    activeFixedTab?.tab.kind === "git-diff" &&
    (resolvedGitDiffTabStatus === "loading" ||
      resolvedGitDiffTabStatus === "error");
  const {
    gitDiffTarget,
    gitDiffSelectOptions,
    gitDiffSelectValue,
    onGitDiffSelectionChange,
  } = useGitDiffPanelState({
    environmentId,
    isDiffPanelActive: isDiffPanelLive,
    requestedMergeBaseBranch,
    onClearPendingGitDiffIntent,
    pendingGitDiffCommitSha,
    pendingGitDiffScrollPath,
  });
  const { data: diffFilesResponse, isLoading: isDiffFilesLoading } =
    useEnvironmentDiffFiles(environmentId ?? "", {
      enabled:
        isDiffPanelLive &&
        Boolean(environmentId) &&
        gitDiffTarget !== undefined,
      target: gitDiffTarget,
    });
  const diffFiles = useMemo(
    () =>
      diffFilesResponse?.outcome === "available"
        ? diffFilesResponse.files
        : EMPTY_DIFF_FILES,
    [diffFilesResponse],
  );
  const diffMergeBaseRef =
    diffFilesResponse?.outcome === "available"
      ? diffFilesResponse.mergeBaseRef
      : null;
  const isGitDiffTruncated =
    diffFilesResponse?.outcome === "available" && diffFilesResponse.truncated;
  const diffIdentity = useMemo(
    () =>
      buildGitDiffIdentity({
        environmentId,
        mergeBaseRef: diffMergeBaseRef,
        target: gitDiffTarget,
      }),
    [diffMergeBaseRef, environmentId, gitDiffTarget],
  );
  const gitDiffStats = useMemo(
    () => summarizeDiffFileEntries(diffFiles),
    [diffFiles],
  );
  const { areAllCollapsed, toggleAllCollapsed, hasFiles } =
    useDiffFilesCollapseControls(diffIdentity, diffFiles);
  const isSecondaryPanelResizing = useAtomValue(
    threadSecondaryPanelResizingAtom,
  );
  const [desktopInfo] = useState(getBbDesktopInfo);
  const [gitDiffLineOverflowMode, setGitDiffLineOverflowMode] =
    useState<CodeOverflowMode>(DEFAULT_CODE_OVERFLOW_MODE);
  const usesDesktopChrome = shouldUseMacosDesktopChrome(desktopInfo);
  const desktopWindowState = useDesktopWindowState();
  const isSidebarShowing = useOptionalIsSidebarShowing();
  const collapsedPanelTrafficLightReserveClassName =
    resolveCollapsedPanelTrafficLightReserveClassName({
      isConversationCollapsed,
      renderAsDrawer,
      isSidebarShowing,
      reserveMacosTrafficLights: shouldReserveMacosTrafficLights({
        desktopInfo,
        windowState: desktopWindowState,
      }),
    });
  const gitDiffPresentation = useMemo<DiffPresentation>(
    () => ({
      view: gitDiffDisplayMode,
      overflow: gitDiffLineOverflowMode,
      showLineNumbers: true,
    }),
    [gitDiffDisplayMode, gitDiffLineOverflowMode],
  );
  const handlePanelFocusCapture = (event: FocusEvent<HTMLElement>) => {
    const previousTarget = event.relatedTarget;
    if (
      previousTarget instanceof Node &&
      event.currentTarget.contains(previousTarget)
    ) {
      return;
    }
    onPanelFocus();
  };

  interface PanelSurfaceArgs {
    activeSurfaceFixedTab: SecondaryPanelFixedTab | undefined;
    activeSurfaceTabId: string | null;
    surfaceTabs: readonly SecondaryPanelRenderableTab[];
    fixedSurfaceTabs: readonly SecondaryPanelFixedTab[];
    isFocused: boolean;
    isFullScreen?: boolean;
    isSurfaceDiffEligibilityPending: boolean;
    onBeginTabDrag?: (
      tabId: string,
      event: ReactPointerEvent<HTMLElement>,
    ) => void;
    onMoveActiveTabToSide?: (side: SplitSide) => void;
    onRemoveSplit?: () => void;
    onToggleFullScreen?: () => void;
    onFocusPane: () => void;
    onSurfaceTabReorder: SecondaryPanelTabReorderHandler;
    paneId: string | null;
    reserveLeadingChrome: boolean;
    reserveNewTabControl: boolean;
    showNewTabControl: boolean;
    showOuterControls: boolean;
    usesPaneArrangementControl: boolean;
    usesWindowChrome: boolean;
  }

  interface PanelTabGroupArgs {
    activeSurfaceFixedTab: SecondaryPanelFixedTab | undefined;
    activeSurfaceTabId: string | null;
    surfaceTabs: readonly SecondaryPanelRenderableTab[];
    fixedSurfaceTabs: readonly SecondaryPanelFixedTab[];
    onBeginTabDrag?: (
      tabId: string,
      event: ReactPointerEvent<HTMLElement>,
    ) => void;
    newTabAriaLabel: string;
    onSurfaceTabReorder: SecondaryPanelTabReorderHandler;
    reserveNewTabButton: boolean;
    showNewTabButton: boolean;
  }

  const renderHidePanelButton = () => (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className={cn(
        SECONDARY_PANEL_HIDE_ICON_BUTTON_CLASS,
        "relative",
        usesDesktopChrome && MACOS_WINDOW_NO_DRAG_CLASS,
      )}
      onClick={onClose}
      aria-label={
        togglePanelShortcut
          ? `${HIDE_PANEL_LABEL} (${togglePanelShortcut.label})`
          : HIDE_PANEL_LABEL
      }
      aria-keyshortcuts={togglePanelShortcut?.ariaKeyshortcuts}
    >
      <Icon name={hidePanelIconName} />
      <AppCommandShortcutHint
        shortcut={togglePanelShortcut}
        className="absolute right-full mr-1"
      />
    </Button>
  );

  const renderRemoveSplitButton = (onRemoveSplit?: () => void) =>
    onRemoveSplit ? (
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className={cn(
          HEADER_PANE_ACTION_ICON_BUTTON_CLASS,
          CHROME_SUBTLE_ICON_BUTTON_FOREGROUND_CLASS,
          "shrink-0",
          usesDesktopChrome && MACOS_WINDOW_NO_DRAG_CLASS,
        )}
        aria-label="Remove split"
        onClick={onRemoveSplit}
      >
        <Icon name="CloseThreadPane" />
      </Button>
    ) : null;

  const renderConversationCollapseButton = ({
    isFullScreen,
    onMoveActiveTabToSide,
    onToggleFullScreen,
    usesPaneArrangementControl,
  }: {
    isFullScreen?: boolean;
    onMoveActiveTabToSide?: (side: SplitSide) => void;
    onToggleFullScreen?: () => void;
    usesPaneArrangementControl: boolean;
  }) => {
    if (usesPaneArrangementControl) {
      if (onToggleFullScreen === undefined) return null;
      return (
        <PaneArrangementButton
          className={cn(
            "shrink-0",
            usesDesktopChrome && MACOS_WINDOW_NO_DRAG_CLASS,
          )}
          isFullScreen={isFullScreen ?? false}
          onMoveToSide={onMoveActiveTabToSide}
          onToggleFullScreen={onToggleFullScreen}
        />
      );
    }
    if (conversationCollapseControl === null) return null;
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className={cn(
              HEADER_PANE_ACTION_ICON_BUTTON_CLASS,
              CHROME_SUBTLE_ICON_BUTTON_FOREGROUND_CLASS,
              "shrink-0",
              usesDesktopChrome && MACOS_WINDOW_NO_DRAG_CLASS,
            )}
            onClick={conversationCollapseControl.onClick}
            aria-label={conversationCollapseControl.label}
            aria-pressed={conversationCollapseControl.isFullScreen}
          >
            <Icon name={conversationCollapseControl.iconName} />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{conversationCollapseControl.label}</TooltipContent>
      </Tooltip>
    );
  };

  const renderPanelTabGroup = ({
    activeSurfaceFixedTab,
    activeSurfaceTabId,
    surfaceTabs,
    fixedSurfaceTabs,
    newTabAriaLabel,
    onBeginTabDrag,
    onSurfaceTabReorder,
    reserveNewTabButton,
    showNewTabButton: showGroupNewTabButton,
  }: PanelTabGroupArgs) => {
    const activeSurfaceTab = surfaceTabs.find(
      (tab) => tab.tab.id === activeSurfaceTabId,
    );
    const visibleSurfaceTabs = surfaceTabs.filter(
      (tab) => tab.isHidden !== true,
    );
    const hasActiveSurfaceTab = activeSurfaceTab !== undefined;

    return (
      <>
        {fixedSurfaceTabs.map((fixedTab) => {
          const shortcut =
            fixedTab.tab.kind === "git-diff" ? diffShortcut : null;
          return (
            <PinnedIconTab
              key={fixedTab.tab.id}
              ariaLabel={
                shortcut
                  ? `${fixedTab.ariaLabel} (${shortcut.label})`
                  : fixedTab.ariaLabel
              }
              ariaKeyshortcuts={shortcut?.ariaKeyshortcuts}
              isActive={
                activeSurfaceFixedTab?.tab.id === fixedTab.tab.id &&
                !hasActiveSurfaceTab
              }
              label={fixedTab.label}
              leadingVisual={fixedTab.leadingVisual}
              onClick={fixedTab.onSelect}
              onPointerDown={
                onBeginTabDrag
                  ? (event) => onBeginTabDrag(fixedTab.tab.id, event)
                  : undefined
              }
              title={fixedTab.title}
              usesDesktopChrome={usesDesktopChrome}
            />
          );
        })}
        {visibleSurfaceTabs.length > 0 ? (
          <SecondaryPanelTabStrip
            activeTabId={activeSurfaceTabId}
            tabs={visibleSurfaceTabs}
            onBeginTabDrag={onBeginTabDrag}
            onReorderTab={onSurfaceTabReorder}
            usesDesktopChrome={usesDesktopChrome}
            isPanelOpen={isOpen}
          />
        ) : null}
        {showGroupNewTabButton ? (
          <NewTabButton
            ariaLabel={newTabAriaLabel}
            onOpenNewTab={onOpenNewTab}
            shortcut={newTabShortcut}
            usesDesktopChrome={usesDesktopChrome}
          />
        ) : reserveNewTabButton ? (
          <div
            aria-hidden
            data-new-tab-control-reserved=""
            className={cn(
              SECONDARY_PANEL_CHROME_ICON_BUTTON_CLASS,
              usesDesktopChrome && MACOS_WINDOW_NO_DRAG_CLASS,
            )}
          />
        ) : null}
      </>
    );
  };

  const renderPanelSurface = ({
    activeSurfaceFixedTab,
    activeSurfaceTabId,
    surfaceTabs,
    fixedSurfaceTabs,
    isFocused,
    isFullScreen,
    isSurfaceDiffEligibilityPending,
    onBeginTabDrag,
    onFocusPane,
    onMoveActiveTabToSide,
    onRemoveSplit,
    onToggleFullScreen,
    onSurfaceTabReorder,
    paneId,
    reserveLeadingChrome,
    reserveNewTabControl,
    showNewTabControl,
    showOuterControls,
    usesPaneArrangementControl,
    usesWindowChrome,
  }: PanelSurfaceArgs) => {
    const activeSurfaceTab =
      surfaceTabs.find((tab) => tab.tab.id === activeSurfaceTabId) ?? null;
    const activeSurfaceModel = activeSurfaceTab?.tab ?? null;
    const hasActiveSurfaceTab = activeSurfaceTab !== null;
    const paneRenderContext = { isFocused, onFocusPane };
    const isBrowserSurfaceActive = activeSurfaceModel?.kind === "browser";
    const browserSurface =
      renderBrowserDeck === undefined ||
      (paneId !== null && !isBrowserSurfaceActive)
        ? null
        : renderBrowserDeck(
            isBrowserSurfaceActive ? activeSurfaceModel.id : null,
            paneRenderContext,
          );
    const surfaceContent =
      activeSurfaceTab === null || isBrowserSurfaceActive
        ? null
        : activeSurfaceTab.renderContent(paneRenderContext);
    const surfaceContentFillsRegion =
      activeSurfaceTab?.contentFillsRegion === true;
    const fixedSurfaceContent =
      activeSurfaceFixedTab?.renderContent?.(paneRenderContext);
    const fixedSurfaceContentFillsRegion =
      activeSurfaceFixedTab?.contentFillsRegion === true;
    const isSurfaceDiffActive =
      activeSurfaceFixedTab?.tab.kind === "git-diff" &&
      resolvedGitDiffTabStatus === "eligible";
    const showsSurfaceDiffToolbar = isSurfaceDiffActive && !hasActiveSurfaceTab;
    const isSurfaceTerminalActive =
      activeSurfaceModel?.kind === "terminal" && hasActiveSurfaceTab;

    return (
      <>
        <div
          className={getSecondaryPanelChromeStackClassName(
            showsSurfaceDiffToolbar,
          )}
        >
          <div
            data-testid="thread-secondary-panel-top-chrome"
            className={cn(
              CHROME_ROW_CLASS,
              "min-w-0 justify-between gap-2 px-4",
              usesDesktopChrome && usesWindowChrome && MACOS_WINDOW_DRAG_CLASS,
              usesDesktopChrome &&
                usesWindowChrome &&
                MACOS_CHROME_CONTROL_AXIS_CLASS,
            )}
          >
            <div
              className={cn(
                "flex min-w-0 flex-1 items-center gap-1",
                `transition-[padding] ${PANEL_COLLAPSE_TRANSITION_CLASS}`,
                reserveLeadingChrome &&
                  collapsedPanelTrafficLightReserveClassName,
              )}
              data-sidebar-split-tab-group={paneId ?? undefined}
              role="toolbar"
              aria-label="Right panel views"
            >
              {renderPanelTabGroup({
                activeSurfaceFixedTab,
                activeSurfaceTabId,
                surfaceTabs,
                fixedSurfaceTabs,
                newTabAriaLabel:
                  onRemoveSplit === undefined
                    ? "Open new tab"
                    : "Open new tab in this pane",
                onBeginTabDrag,
                onSurfaceTabReorder,
                reserveNewTabButton: reserveNewTabControl,
                showNewTabButton: showNewTabControl,
              })}
            </div>
            {showOuterControls ||
            onRemoveSplit ||
            usesPaneArrangementControl ? (
              <div
                className="flex min-w-0 shrink-0 items-center gap-1"
                onPointerDown={(event) => event.stopPropagation()}
              >
                {usesPaneArrangementControl || showOuterControls
                  ? renderConversationCollapseButton({
                      isFullScreen,
                      onMoveActiveTabToSide,
                      onToggleFullScreen,
                      usesPaneArrangementControl,
                    })
                  : null}
                {renderRemoveSplitButton(onRemoveSplit)}
                {showOuterControls ? (
                  renderAsDrawer || inlinePanelToggle === "button" ? (
                    renderHidePanelButton()
                  ) : inlinePanelToggle === "reserved" ? (
                    <div
                      aria-hidden
                      className={getReservedInlinePanelToggleClassName(
                        usesDesktopChrome,
                      )}
                    />
                  ) : null
                ) : null}
              </div>
            ) : null}
          </div>
          {showsSurfaceDiffToolbar ? (
            <GitDiffToolbar
              selectionValue={gitDiffSelectValue}
              selectionOptions={gitDiffSelectOptions}
              onSelectionChange={onGitDiffSelectionChange}
              isSelectorDisabled={
                isDiffFilesLoading || gitDiffTarget === undefined
              }
              stats={gitDiffStats}
              isTruncated={isGitDiffTruncated}
              areAllFilesCollapsed={areAllCollapsed}
              isCollapseAllDisabled={!hasFiles || isDiffFilesLoading}
              onToggleAllCollapsed={toggleAllCollapsed}
              displayMode={gitDiffDisplayMode}
              onDisplayModeChange={handleGitDiffDisplayModeChange}
              lineOverflowMode={gitDiffLineOverflowMode}
              onLineOverflowModeChange={setGitDiffLineOverflowMode}
            />
          ) : null}
        </div>
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-sidebar">
          {browserSurface}
          {isBrowserSurfaceActive ? null : hasActiveSurfaceTab ? (
            <div
              className={
                isSurfaceTerminalActive || surfaceContentFillsRegion
                  ? "min-h-0 flex-1 overflow-hidden"
                  : cn(PANEL_SCROLL_SLOT_CLASS, "pb-3")
              }
              data-file-preview-scroll-container={
                isSurfaceTerminalActive || surfaceContentFillsRegion
                  ? undefined
                  : ""
              }
            >
              {surfaceContent ?? (
                <EmptyStatePanel className="mx-4 rounded-lg">
                  No file preview content provided.
                </EmptyStatePanel>
              )}
            </div>
          ) : activeSurfaceFixedTab !== undefined &&
            fixedSurfaceContent !== undefined ? (
            <div
              className={
                fixedSurfaceContentFillsRegion
                  ? "flex min-h-0 flex-1 flex-col overflow-hidden"
                  : cn(PANEL_SCROLL_SLOT_CLASS, "p-4 pb-3")
              }
            >
              {fixedSurfaceContent}
            </div>
          ) : isSurfaceDiffEligibilityPending ? (
            <EmptyStatePanel className="m-4 rounded-lg" role="status">
              {resolvedGitDiffTabStatus === "error" ? (
                <div className="flex flex-col items-center gap-3 text-center">
                  <span>
                    Could not determine whether this workspace uses Git.
                  </span>
                  {onRetryGitDiffEligibility ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={onRetryGitDiffEligibility}
                    >
                      Retry
                    </Button>
                  ) : null}
                </div>
              ) : (
                "Checking Git support…"
              )}
            </EmptyStatePanel>
          ) : isSurfaceDiffActive ? (
            <GitDiffTabContent
              environmentId={environmentId}
              target={gitDiffTarget}
              isDiffPanelActive={isSurfaceDiffActive}
              isPanelOpen={isLayoutOpen}
              gitDiffPresentation={gitDiffPresentation}
              onClearPendingGitDiffIntent={onClearPendingGitDiffIntent}
              onOpenFileInEditor={onOpenFileInEditor}
              onOpenFilePreview={onOpenFilePreview}
              onSelectionAddToChat={onSelectionAddToChat}
              pendingGitDiffScrollPath={pendingGitDiffScrollPath}
              workspaceRootPath={workspaceRootPath}
            />
          ) : activeSurfaceFixedTab?.tab.kind === "thread-info" ? (
            <div className="flex min-h-0 flex-1 flex-col">
              {metadataContent}
            </div>
          ) : (
            <EmptyStatePanel className="m-4 rounded-lg">
              This panel view is unavailable.
            </EmptyStatePanel>
          )}
        </div>
      </>
    );
  };

  const shouldEnableSidebarSplits =
    !renderAsDrawer && splitPanelStateId !== undefined;
  const splitTabs = shouldEnableSidebarSplits
    ? ([
        ...fixedTabs.map((fixedTab) => ({
          id: fixedTab.tab.id,
          label: fixedTab.label,
        })),
        ...visibleTabs.map((tab) => ({
          id: tab.tab.id,
          label: tab.label,
        })),
      ] satisfies SidebarSplitTabDescriptor[])
    : [];
  const globalActiveTabId =
    activeRenderableTab?.tab.id ??
    activeFixedTab?.tab.id ??
    fixedTabs[0]?.tab.id ??
    SIDEBAR_FIXED_INFO_TAB_ID;
  const resolveSplitPaneTabs = (pane: SidebarSplitPaneRenderArgs) =>
    pane.group.tabIds
      .map((tabId) => tabs.find((tab) => tab.tab.id === tabId))
      .filter((tab): tab is SecondaryPanelRenderableTab => tab !== undefined)
      .map((tab) => ({
        ...tab,
        onSelect: () => pane.onSelectTab(tab.tab.id),
      }));
  const panelSurface = shouldEnableSidebarSplits ? (
    <SidebarSplitContainer
      key={splitPanelStateId}
      activeTabId={globalActiveTabId}
      isFullScreen={isConversationCollapsed}
      onActivateTab={(tabId) => {
        const fixedTab = fixedTabs.find(
          (candidate) => candidate.tab.id === tabId,
        );
        if (fixedTab !== undefined) fixedTab.onSelect();
        else tabs.find((tab) => tab.tab.id === tabId)?.onSelect();
      }}
      onGlobalTabReorder={onTabReorder}
      onToggleFullScreen={onToggleConversationCollapse}
      panelStateId={splitPanelStateId}
      tabs={splitTabs}
      renderPane={(pane: SidebarSplitPaneRenderArgs) => {
        const activePaneTabId = pane.group.activeTabId;
        const isSplitPane = pane.onRemoveSplit !== undefined;
        const paneTabs = resolveSplitPaneTabs(pane);
        const paneFixedTabs = fixedTabs
          .filter((fixedTab) => pane.group.tabIds.includes(fixedTab.tab.id))
          .map((fixedTab) => ({
            ...fixedTab,
            onSelect: () => pane.onSelectTab(fixedTab.tab.id),
          }));
        const activePaneFixedTab = paneFixedTabs.find(
          (fixedTab) => fixedTab.tab.id === activePaneTabId,
        );
        return renderPanelSurface({
          activeSurfaceFixedTab: activePaneFixedTab,
          activeSurfaceTabId: activePaneTabId,
          surfaceTabs: paneTabs,
          fixedSurfaceTabs: paneFixedTabs,
          isFocused: pane.isFocused,
          isFullScreen: pane.isMaximized,
          isSurfaceDiffEligibilityPending:
            activePaneFixedTab?.tab.kind === "git-diff" &&
            (resolvedGitDiffTabStatus === "loading" ||
              resolvedGitDiffTabStatus === "error"),
          onBeginTabDrag: pane.onBeginTabDrag,
          onFocusPane: pane.onFocusPane,
          onMoveActiveTabToSide: pane.onMoveActiveTabToSide,
          onRemoveSplit: pane.onRemoveSplit,
          onToggleFullScreen: pane.onToggleMaximize,
          onSurfaceTabReorder: pane.onReorderTab,
          paneId: pane.paneId,
          reserveLeadingChrome: pane.isTopRow && pane.isLeftEdge,
          reserveNewTabControl:
            isSplitPane && !pane.isFocused && showNewTabButton,
          showNewTabControl:
            (!isSplitPane || pane.isFocused) && showNewTabButton,
          showOuterControls: pane.showOuterControls,
          usesPaneArrangementControl: true,
          usesWindowChrome: pane.isTopRow,
        });
      }}
    />
  ) : (
    renderPanelSurface({
      activeSurfaceFixedTab: activeFixedTab,
      activeSurfaceTabId: activeRenderableTab?.tab.id ?? activeTab?.id ?? null,
      surfaceTabs: tabs,
      fixedSurfaceTabs: fixedTabs,
      isFocused: true,
      isSurfaceDiffEligibilityPending: isDiffEligibilityPending,
      onFocusPane: onPanelFocus,
      onSurfaceTabReorder: onTabReorder,
      paneId: null,
      reserveLeadingChrome: true,
      reserveNewTabControl: false,
      showNewTabControl: showNewTabButton,
      showOuterControls: true,
      usesPaneArrangementControl: false,
      usesWindowChrome: true,
    })
  );

  const asideMarkup = (
    <aside
      ref={panelRef}
      aria-hidden={!isOpen}
      inert={!isOpen}
      onFocusCapture={handlePanelFocusCapture}
      style={
        !renderAsDrawer && !isSecondaryPanelResizing
          ? {
              width: isConversationCollapsed
                ? "100%"
                : `var(--secondary-swipe-width, ${persistedWidthPercent}cqw)`,
            }
          : undefined
      }
      className={cn(
        "flex h-full min-h-0 flex-col overflow-hidden bg-sidebar",
        renderAsDrawer && "min-w-0 flex-1",
        !renderAsDrawer && [
          "absolute inset-y-0 left-0",
          hostLayout === null &&
            !isConversationCollapsed &&
            "border-l border-border-seam",
          isSecondaryPanelResizing && "right-0",
          !isOpen && "pointer-events-none",
        ],
      )}
    >
      {panelSurface}
      <IframeDragGuardOverlay
        active={isSecondaryPanelResizing}
        cursor="col-resize"
      />
    </aside>
  );

  if (renderAsDrawer) {
    return asideMarkup;
  }

  return (
    <>
      <SecondaryPanelResizeHandle
        isOpen={isOpen}
        isConversationCollapsed={isConversationCollapsed}
        matchesSplitDividers={hostLayout !== null}
        onDragging={handleSecondaryPanelDragging}
        onPointerDown={handleSecondaryPanelResizePointerDownCapture}
      />
      <Panel
        ref={resizablePanelRef}
        id={resizablePanelId}
        collapsible
        collapsedSize={0}
        defaultSize={
          isLayoutOpen
            ? isConversationCollapsed
              ? CONVERSATION_COLLAPSED_PANEL_SIZE_PERCENT
              : persistedWidthPercent
            : 0
        }
        minSize={THREAD_SECONDARY_PANEL_MIN_SIZE_PERCENT}
        maxSize={
          isConversationCollapsed
            ? CONVERSATION_COLLAPSED_PANEL_SIZE_PERCENT
            : THREAD_SECONDARY_PANEL_MAX_SIZE_PERCENT
        }
        onCollapse={handlePanelCollapse}
        onResize={handlePanelResize}
        onTransitionEnd={handlePanelTransitionEnd}
        order={2}
        style={SECONDARY_RESIZABLE_PANEL_STYLE}
        className={cn(
          "min-w-0 overflow-clip",
          `relative transition-[flex-grow,flex-basis] ${PANEL_COLLAPSE_TRANSITION_CLASS}`,
        )}
      >
        {asideMarkup}
      </Panel>
    </>
  );
}

interface NewTabButtonProps {
  ariaLabel: string;
  onOpenNewTab: () => void;
  shortcut: AppShortcutPresentation | null;
  usesDesktopChrome: boolean;
}

interface PinnedIconTabProps {
  ariaLabel: string;
  ariaKeyshortcuts?: string;
  isActive: boolean;
  label: string;
  leadingVisual: ReactNode;
  onClick: () => void;
  onPointerDown?: (event: ReactPointerEvent<HTMLElement>) => void;
  title: string;
  usesDesktopChrome: boolean;
}

function PinnedIconTab({
  ariaLabel,
  ariaKeyshortcuts,
  isActive,
  label,
  leadingVisual,
  onClick,
  onPointerDown,
  title,
  usesDesktopChrome,
}: PinnedIconTabProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div
          data-testid={label === "Info" ? "thread-info-tab" : undefined}
          className={cn(
            "shrink-0",
            usesDesktopChrome && MACOS_WINDOW_NO_DRAG_CLASS,
          )}
          onPointerDown={onPointerDown}
        >
          <TabPill
            label={label}
            ariaLabel={ariaLabel}
            ariaKeyshortcuts={ariaKeyshortcuts}
            iconOnly
            leadingVisual={leadingVisual}
            title={title}
            isActive={isActive}
            onSelect={onClick}
            closeAction={null}
          />
        </div>
      </TooltipTrigger>
      <TooltipContent>{title}</TooltipContent>
    </Tooltip>
  );
}

function NewTabButton({
  ariaLabel,
  onOpenNewTab,
  shortcut,
  usesDesktopChrome,
}: NewTabButtonProps) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className={cn(
        SECONDARY_PANEL_CHROME_ICON_BUTTON_CLASS,
        usesDesktopChrome && MACOS_WINDOW_NO_DRAG_CLASS,
      )}
      onClick={onOpenNewTab}
      aria-label={shortcut ? `${ariaLabel} (${shortcut.label})` : ariaLabel}
      aria-keyshortcuts={shortcut?.ariaKeyshortcuts}
    >
      <Icon name="Plus" />
    </Button>
  );
}

interface SecondaryPanelResizeHandleProps {
  isOpen: boolean;
  isConversationCollapsed: boolean;
  matchesSplitDividers: boolean;
  onDragging: SecondaryPanelDraggingHandler;
  onPointerDown: (event: PointerEvent) => void;
}

function SecondaryPanelResizeHandle({
  isOpen,
  isConversationCollapsed,
  matchesSplitDividers,
  onDragging,
  onPointerDown,
}: SecondaryPanelResizeHandleProps) {
  const isResizing = useAtomValue(threadSecondaryPanelResizingAtom);
  return (
    <PanelResizeHandle
      id="thread-detail-secondary-panel-handle"
      disabled={!isOpen || isConversationCollapsed}
      onDragging={onDragging}
      onPointerDownCapture={(event) => onPointerDown(event.nativeEvent)}
      data-panel-resize-snap-handle=""
      hitAreaMargins={PANEL_RESIZE_HIT_AREA_MARGINS}
      className={cn(
        "group relative shrink-0 overflow-visible transition-[width,opacity,background-color]",
        PANEL_RESIZE_HANDLE_LAYER_CLASS,
        PANEL_COLLAPSE_TRANSITION_CLASS,
        isConversationCollapsed ? "cursor-default" : "cursor-col-resize",
        matchesSplitDividers
          ? [
              "bg-border-seam hover:bg-ring/40",
              isOpen && !isConversationCollapsed
                ? "w-px opacity-100"
                : "pointer-events-none w-0 opacity-0",
              isResizing && "bg-ring/40",
            ]
          : [
              "bg-transparent",
              isOpen && !isConversationCollapsed
                ? "w-0 opacity-100"
                : "pointer-events-none w-0 opacity-0",
              isResizing && "bg-accent/20",
            ],
      )}
      aria-label="Resize thread and right panel"
    >
      <span
        aria-hidden
        data-panel-resize-hit-target=""
        className={PANEL_RESIZE_HIT_TARGET_CLASS}
      />
      {matchesSplitDividers ? null : (
        <span
          className={cn(
            "pointer-events-none absolute inset-y-0 left-full z-10 w-px transition-colors",
            isResizing
              ? "bg-accent-foreground/50"
              : "bg-border-seam group-hover:bg-accent-foreground/35",
          )}
        />
      )}
    </PanelResizeHandle>
  );
}
