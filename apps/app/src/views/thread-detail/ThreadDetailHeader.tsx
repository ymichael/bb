import {
  useCallback,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { Button } from "@bb/shared-ui/button";
import { useAtomValue } from "jotai";
import { COARSE_POINTER_TOOLBAR_ACTION_BUTTON_CLASS } from "@bb/shared-ui/coarse-pointer-sizing";
import { Icon } from "@bb/shared-ui/icon";
import { Pill } from "@bb/shared-ui/pill";
import { SplitButton } from "@/components/ui/split-button.js";
import {
  AppPageHeader,
  COMPACT_SHELF_HIDDEN_PAGE_HEADER_ACTIONS_CLASS,
  HEADER_ICON_BUTTON_CLASS,
  HEADER_PANE_ACTION_ICON_BUTTON_CLASS,
} from "@/components/layout/AppPageHeader";
import type { ThreadGitActionDialogTarget } from "@/components/dialogs/ThreadGitActionDialog";
import {
  getBbDesktopInfo,
  MACOS_WINDOW_NO_DRAG_CLASS,
  shouldUseMacosDesktopChrome,
} from "@/lib/bb-desktop";
import { cn } from "@bb/shared-ui/lib/utils";
import { useAppCommandShortcut } from "@/components/commands/AppCommandProvider";
import { AppCommandShortcutHint } from "@/components/commands/AppCommandShortcutHint";
import { useInlineThreadTitle } from "@/components/thread/InlineThreadTitle";
import { useThreadActions } from "@/components/thread/ThreadActionsProvider";
import { ThreadTitleMentions } from "@/components/thread/ThreadTitleMentions";
import { SecondaryPanelHostLayoutContext } from "@/components/secondary-panel/SecondaryPanelHostLayoutContext";
import { RIGHT_PANEL_TOGGLE_ICON_NAME } from "@/components/secondary-panel/panelToggleControlState";
import { CHROME_SUBTLE_ICON_BUTTON_FOREGROUND_CLASS } from "@bb/shared-ui/chrome-style-tokens";
import { useIsCompactViewport } from "@bb/shared-ui/hooks/use-compact-viewport";
import { dimInactiveSplitsAtom } from "@/lib/split-layout/atoms";
import {
  CONTEXT_INACTIVE_TEXT_CLASS,
  CONTEXT_SELECTION_SURFACE_CLASS,
} from "@/components/ui/context-selection";
import { usePaneContext } from "./PaneContext";
import { PaneMaximizeButton } from "./PaneMaximizeButton";
import type { ThreadHeaderGitAction } from "./useThreadGitActions";

const THREAD_HEADER_ACTION_BUTTON_CLASS = cn(
  COARSE_POINTER_TOOLBAR_ACTION_BUTTON_CLASS,
  "border-border/70 bg-transparent font-normal hover:bg-state-hover",
);
const NARROW_SPLIT_HEADER_MAX_WIDTH = 560;

interface ThreadDetailHeaderProps {
  actionsMenu: ((includeResponsiveActions: boolean) => ReactNode) | null;
  childPillLabel: "child" | "side chat" | null;
  isSecondaryPanelOpen: boolean;
  onClosePane?: () => void;
  onOpenThreadGitAction: (target: ThreadGitActionDialogTarget) => void;
  onToggleSecondaryPanel: () => void;
  pluginActions?: ReactNode;
  threadHeaderGitActions: ThreadHeaderGitAction[];
  threadId: string;
  threadTitle: string;
  workspaceOpenButton?: ReactNode;
}

export function ThreadDetailHeader({
  actionsMenu,
  childPillLabel,
  isSecondaryPanelOpen,
  onClosePane,
  onOpenThreadGitAction,
  onToggleSecondaryPanel,
  pluginActions,
  threadHeaderGitActions,
  threadId,
  threadTitle,
  workspaceOpenButton,
}: ThreadDetailHeaderProps) {
  const isCompactViewport = useIsCompactViewport();
  const [primaryAction, ...secondaryActions] = threadHeaderGitActions;
  const { renameThread } = useThreadActions();
  const handleRename = useCallback(
    (nextTitle: string) => {
      renameThread(threadId, nextTitle);
    },
    [renameThread, threadId],
  );
  const { editor, isEditing, startEditing } = useInlineThreadTitle({
    onCommit: handleRename,
    resetKey: threadId,
    title: threadTitle,
  });
  const [desktopInfo] = useState(getBbDesktopInfo);
  const dimsInactiveSplits = useAtomValue(dimInactiveSplitsAtom);
  const panelShortcut = useAppCommandShortcut("panel.toggle");
  const usesDesktopChrome = shouldUseMacosDesktopChrome(desktopInfo);
  const headerRef = useRef<HTMLElement>(null!);
  const {
    beginPaneDrag,
    isFocused,
    isTopRow,
    ownsWindowTopLeft,
    reservesWindowPanelToggle,
    secondaryPanelHost,
  } = usePaneContext();
  const isWindowPanelOpen =
    useContext(SecondaryPanelHostLayoutContext)?.isOpen === true;
  const isSplitPaneHeader = beginPaneDrag !== undefined;
  const [measuredPaneWidth, setMeasuredPaneWidth] = useState(0);
  const usesResponsiveActionOverflow =
    isSplitPaneHeader &&
    measuredPaneWidth > 0 &&
    measuredPaneWidth < NARROW_SPLIT_HEADER_MAX_WIDTH;
  useLayoutEffect(() => {
    if (!isSplitPaneHeader) {
      return;
    }

    const header = headerRef.current;
    const pane = header.closest<HTMLElement>("[data-split-pane-id]");
    const measuredElement = pane ?? header;
    const measure = () => {
      const width = measuredElement.getBoundingClientRect().width;
      if (width > 0) {
        setMeasuredPaneWidth(width);
      }
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(measuredElement);
    return () => {
      observer.disconnect();
    };
  }, [isSplitPaneHeader]);
  const handleTitlePointerDown = (event: ReactPointerEvent) => {
    if (isEditing || !beginPaneDrag || event.button !== 0) {
      return;
    }
    beginPaneDrag(event, threadTitle);
  };
  const handleTitleDoubleClick = () => {
    if (isEditing) {
      return;
    }
    startEditing();
  };
  const rightPanelLabel = isSecondaryPanelOpen
    ? "Hide right panel"
    : "Show right panel";
  const rightPanelIconName = RIGHT_PANEL_TOGGLE_ICON_NAME;
  const showRightPanelToggle =
    secondaryPanelHost === null &&
    (!isSecondaryPanelOpen || isCompactViewport);

  const center = (
    <>
      <div
        data-pane-header-focus-tab={
          isSplitPaneHeader && isFocused ? "" : undefined
        }
        className={cn(
          "relative min-w-0",
          isSplitPaneHeader && "-mx-2 -my-1 rounded-md px-2 py-1",
          isSplitPaneHeader && isFocused && CONTEXT_SELECTION_SURFACE_CLASS,
        )}
      >
        <p
          className={cn(
            "relative min-w-0 text-sm font-normal transition-colors",
            isEditing ? "overflow-visible" : "truncate",
            isSplitPaneHeader &&
              !isFocused &&
              dimsInactiveSplits &&
              CONTEXT_INACTIVE_TEXT_CLASS,
            beginPaneDrag &&
              !isEditing &&
              cn(
                "cursor-grab touch-none select-none",
                usesDesktopChrome && MACOS_WINDOW_NO_DRAG_CLASS,
              ),
          )}
          onDoubleClick={handleTitleDoubleClick}
          onPointerDown={beginPaneDrag ? handleTitlePointerDown : undefined}
        >
          {isEditing ? editor : <ThreadTitleMentions title={threadTitle} />}
        </p>
      </div>
      {childPillLabel ? (
        <Pill variant="outline" size="sm">
          {childPillLabel}
        </Pill>
      ) : null}
      {}
      {actionsMenu == null ? null : (
        <span
          data-testid="thread-detail-header-actions-menu"
          className={cn(
            "flex items-center",
            COMPACT_SHELF_HIDDEN_PAGE_HEADER_ACTIONS_CLASS,
            usesDesktopChrome && MACOS_WINDOW_NO_DRAG_CLASS,
          )}
        >
          {actionsMenu(usesResponsiveActionOverflow)}
        </span>
      )}
    </>
  );

  const actions = (
    <>
      <div
        className="flex items-center gap-1"
        data-thread-header-workflow-actions=""
      >
        {pluginActions}
        {!usesResponsiveActionOverflow && workspaceOpenButton ? (
          <span className="inline-flex" data-thread-header-responsive-action="">
            {workspaceOpenButton}
          </span>
        ) : null}
        {!usesResponsiveActionOverflow && primaryAction ? (
          <span className="inline-flex" data-thread-header-responsive-action="">
            {secondaryActions.length > 0 ? (
              <SplitButton
                className={THREAD_HEADER_ACTION_BUTTON_CLASS}
                primaryAction={{
                  label: primaryAction.label,
                  onSelect: () => onOpenThreadGitAction(primaryAction.target),
                }}
                secondaryActions={secondaryActions.map((action) => ({
                  label: action.label,
                  onSelect: () => onOpenThreadGitAction(action.target),
                }))}
              />
            ) : (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className={THREAD_HEADER_ACTION_BUTTON_CLASS}
                onClick={() => onOpenThreadGitAction(primaryAction.target)}
              >
                {primaryAction.label}
              </Button>
            )}
          </span>
        ) : null}
      </div>
      <div
        className="ml-1 flex items-center gap-0.5"
        data-thread-header-pane-actions=""
      >
        {showRightPanelToggle ? (
          <span className="inline-flex items-center gap-1.5">
            <AppCommandShortcutHint shortcut={panelShortcut} />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className={cn(
                HEADER_ICON_BUTTON_CLASS,
                CHROME_SUBTLE_ICON_BUTTON_FOREGROUND_CLASS,
              )}
              aria-label={
                panelShortcut
                  ? `${rightPanelLabel} (${panelShortcut.label})`
                  : rightPanelLabel
              }
              aria-keyshortcuts={panelShortcut?.ariaKeyshortcuts}
              aria-expanded={isSecondaryPanelOpen}
              onClick={onToggleSecondaryPanel}
            >
              <Icon name={rightPanelIconName} />
            </Button>
          </span>
        ) : null}
        <PaneMaximizeButton />
        {onClosePane ? (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className={cn(
              HEADER_PANE_ACTION_ICON_BUTTON_CLASS,
              CHROME_SUBTLE_ICON_BUTTON_FOREGROUND_CLASS,
            )}
            aria-label="Close pane"
            onClick={onClosePane}
          >
            <Icon name="CloseThreadPane" />
          </Button>
        ) : null}
        {reservesWindowPanelToggle && !isWindowPanelOpen ? (
          <span aria-hidden className={HEADER_ICON_BUTTON_CLASS} />
        ) : null}
      </div>
    </>
  );

  return (
    <AppPageHeader
      headerRef={headerRef}
      center={center}
      actions={actions}
      isWindowDragRegion={isTopRow}
      ownsWindowTopLeft={ownsWindowTopLeft}
      className={beginPaneDrag ? "z-[21]" : undefined}
    />
  );
}
