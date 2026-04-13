import type { ReactNode } from "react";
import { PanelRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SplitButton } from "@/components/ui/split-button";
import { Separator } from "@/components/ui/separator";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { StatusPill } from "@bb/ui-core";
import type { ThreadGitActionDialogTarget } from "@/components/thread/ThreadGitActionDialog";

const THREAD_HEADER_ACTION_BUTTON_CLASS =
  "h-7 rounded-md border-border/70 bg-background/70 px-2 text-xs font-medium text-foreground/85 shadow-none hover:bg-muted/45 hover:text-foreground";

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

  return (
    <header className="shrink-0 border-b border-border/80 bg-background/95 px-4 backdrop-blur-sm">
      <div className="flex h-12 items-center gap-3">
        <SidebarTrigger className="h-5 w-5 shrink-0 rounded-md p-0" />
        <Separator orientation="vertical" className="h-4" />
        <div className="min-w-0 flex-1 flex items-center gap-2">
          <p className="truncate text-sm font-semibold">{threadTitle}</p>
          {isManagerThread ? <StatusPill variant="outline">manager</StatusPill> : null}
          {!isManagerThread && isManagedThread ? (
            <StatusPill variant="outline">managed</StatusPill>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {workspaceOpenButton}
          {primaryAction && secondaryActions.length > 0 ? (
            <SplitButton
              variant="outline"
              size="sm"
              disabled={isThreadGitActionPending}
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
            className={
              isSecondaryPanelOpen
                ? "h-7 w-7 rounded-md p-0 bg-accent/35 text-foreground hover:bg-accent/45"
                : "h-7 w-7 rounded-md p-0 text-muted-foreground hover:bg-accent/45 hover:text-foreground"
            }
            aria-label={isSecondaryPanelOpen ? "Hide secondary panel" : "Show secondary panel"}
            title={isSecondaryPanelOpen ? "Hide secondary panel" : "Show secondary panel"}
            onClick={onToggleSecondaryPanel}
          >
            <PanelRight className="size-3.5" />
          </Button>
        </div>
      </div>
    </header>
  );
}
