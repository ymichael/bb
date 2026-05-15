import type { ReactNode } from "react";
import { Button } from "@/components/ui/button.js";
import { COARSE_POINTER_TOOLBAR_ACTION_BUTTON_CLASS } from "@/components/ui/coarse-pointer-sizing.js";
import { Icon } from "@/components/ui/icon.js";
import { SplitButton } from "@/components/ui/split-button.js";
import { Pill } from "@/components/ui/pill.js";
import { useIsCompactViewport } from "@/components/ui/hooks/use-compact-viewport.js";
import {
  AppPageHeader,
  HEADER_ICON_BUTTON_CLASS,
} from "@/components/layout/AppPageHeader";
import { cn } from "@/lib/utils";
import type { ThreadGitActionDialogTarget } from "@/components/dialogs/ThreadGitActionDialog";

const THREAD_HEADER_ACTION_BUTTON_CLASS =
  COARSE_POINTER_TOOLBAR_ACTION_BUTTON_CLASS;

interface ThreadHeaderGitAction {
  label: string;
  target: ThreadGitActionDialogTarget;
}

interface ThreadDetailHeaderProps {
  actionsMenu: ReactNode;
  isManagedThread: boolean;
  isManagerThread: boolean;
  isSecondaryPanelOpen: boolean;
  isThreadGitActionPending: boolean;
  onOpenThreadGitAction: (target: ThreadGitActionDialogTarget) => void;
  onToggleSecondaryPanel: () => void;
  threadHeaderGitActions: ThreadHeaderGitAction[];
  threadTitle: string;
  workspaceOpenButton?: ReactNode;
}

export function ThreadDetailHeader({
  actionsMenu,
  isManagedThread,
  isManagerThread,
  isSecondaryPanelOpen,
  isThreadGitActionPending,
  onOpenThreadGitAction,
  onToggleSecondaryPanel,
  threadHeaderGitActions,
  threadTitle,
  workspaceOpenButton,
}: ThreadDetailHeaderProps) {
  const [primaryAction, ...secondaryActions] = threadHeaderGitActions;
  const renderAsDrawer = useIsCompactViewport();
  const secondaryPanelIconName = renderAsDrawer ? "PanelBottom" : "PanelRight";

  const center = (
    <>
      <p className="truncate text-sm font-semibold">{threadTitle}</p>
      {isManagerThread ? (
        <Pill variant="outline">manager</Pill>
      ) : null}
      {!isManagerThread && isManagedThread ? (
        <Pill variant="outline">managed</Pill>
      ) : null}
    </>
  );

  const actions = (
    <>
      {workspaceOpenButton}
      {primaryAction && secondaryActions.length > 0 ? (
        <SplitButton
          disabled={isThreadGitActionPending}
          primaryAction={{
            label: primaryAction.label,
            onSelect: () => onOpenThreadGitAction(primaryAction.target),
          }}
          secondaryActions={secondaryActions.map((action) => ({
            label: action.label,
            onSelect: () => onOpenThreadGitAction(action.target),
          }))}
        />
      ) : primaryAction ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={isThreadGitActionPending}
          className={THREAD_HEADER_ACTION_BUTTON_CLASS}
          onClick={() => onOpenThreadGitAction(primaryAction.target)}
        >
          {primaryAction.label}
        </Button>
      ) : null}
      {actionsMenu}
      {!renderAsDrawer && isSecondaryPanelOpen ? null : (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className={cn(HEADER_ICON_BUTTON_CLASS, "text-muted-foreground")}
          aria-label={
            isSecondaryPanelOpen ? "Hide secondary panel" : "Show secondary panel"
          }
          aria-pressed={isSecondaryPanelOpen}
          title={
            isSecondaryPanelOpen ? "Hide secondary panel" : "Show secondary panel"
          }
          onClick={onToggleSecondaryPanel}
        >
          <Icon name={secondaryPanelIconName} />
        </Button>
      )}
    </>
  );

  return <AppPageHeader center={center} actions={actions} />;
}
