import type { ReactNode } from "react";
import { PanelBottom, PanelRight } from "lucide-react";
import { useIsSecondaryPanelOpen } from "@/lib/thread-secondary-panel";
import { Button } from "@/components/ui/button";
import { SplitButton } from "@/components/ui/split-button";
import {
  AppPageHeader,
  HEADER_ICON_BUTTON_CLASS,
} from "@/components/layout/AppPageHeader";
import { StatusPill } from "@bb/ui-core";
import { useIsMobile } from "@/hooks/useMobile";
import { cn } from "@/lib/utils";
import type { ThreadGitActionDialogTarget } from "@/components/thread/ThreadGitActionDialog";
import type { ThreadEnvironmentPromotionDialogTarget } from "@/components/thread/ThreadEnvironmentPromotionDialog";

const THREAD_HEADER_ACTION_BUTTON_CLASS =
  "h-9 rounded-md border-border/70 bg-background/70 px-2 text-xs font-medium text-foreground/85 shadow-none hover:bg-muted/45 hover:text-foreground md:h-8";

interface ThreadHeaderGitAction {
  label: string;
  target: ThreadGitActionDialogTarget;
}

interface ThreadHeaderPromotionAction {
  disabled: boolean;
  label: string;
  target: ThreadEnvironmentPromotionDialogTarget;
  title: string;
}

interface ThreadDetailHeaderProps {
  actionsMenu: ReactNode;
  isManagedThread: boolean;
  isManagerThread: boolean;
  isPromoted: boolean;
  isThreadGitActionPending: boolean;
  onOpenThreadGitAction: (target: ThreadGitActionDialogTarget) => void;
  onOpenThreadPromotionAction: (
    target: ThreadEnvironmentPromotionDialogTarget,
  ) => void;
  onToggleSecondaryPanel: () => void;
  threadHeaderGitActions: ThreadHeaderGitAction[];
  threadHeaderPromotionAction: ThreadHeaderPromotionAction | null;
  threadTitle: string;
  workspaceOpenButton?: ReactNode;
}

export function ThreadDetailHeader({
  actionsMenu,
  isManagedThread,
  isManagerThread,
  isPromoted,
  isThreadGitActionPending,
  onOpenThreadGitAction,
  onOpenThreadPromotionAction,
  onToggleSecondaryPanel,
  threadHeaderGitActions,
  threadHeaderPromotionAction,
  threadTitle,
  workspaceOpenButton,
}: ThreadDetailHeaderProps) {
  const [primaryAction, ...secondaryActions] = threadHeaderGitActions;
  const isMobile = useIsMobile();
  const isSecondaryPanelOpen = useIsSecondaryPanelOpen();
  const SecondaryPanelIcon = isMobile ? PanelBottom : PanelRight;

  const center = (
    <>
      <p className="truncate text-sm font-semibold">{threadTitle}</p>
      {isManagerThread ? (
        <StatusPill variant="outline">manager</StatusPill>
      ) : null}
      {!isManagerThread && isManagedThread ? (
        <StatusPill variant="outline">managed</StatusPill>
      ) : null}
      {isPromoted ? <StatusPill variant="outline">promoted</StatusPill> : null}
    </>
  );

  const actions = (
    <>
      {workspaceOpenButton}
      {threadHeaderPromotionAction ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={threadHeaderPromotionAction.disabled}
          title={threadHeaderPromotionAction.title}
          className={THREAD_HEADER_ACTION_BUTTON_CLASS}
          onClick={() =>
            onOpenThreadPromotionAction(threadHeaderPromotionAction.target)
          }
        >
          {threadHeaderPromotionAction.label}
        </Button>
      ) : null}
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
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className={cn(
          HEADER_ICON_BUTTON_CLASS,
          isSecondaryPanelOpen
            ? "bg-accent/35 text-foreground hover:bg-accent/45"
            : "text-muted-foreground hover:bg-accent/45 hover:text-foreground",
        )}
        aria-label={
          isSecondaryPanelOpen ? "Hide secondary panel" : "Show secondary panel"
        }
        title={
          isSecondaryPanelOpen ? "Hide secondary panel" : "Show secondary panel"
        }
        onClick={onToggleSecondaryPanel}
      >
        <SecondaryPanelIcon />
      </Button>
    </>
  );

  return <AppPageHeader center={center} actions={actions} />;
}
