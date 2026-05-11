import type { ReactNode } from "react";
import { PanelBottom, PanelRight } from "lucide-react";
import { useIsSecondaryPanelOpen } from "@/lib/thread-secondary-panel";
import {
  Button,
  COARSE_POINTER_TOOLBAR_ACTION_BUTTON_CLASS,
  SplitButton,
  StatusPill,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
  useIsMobile,
} from "@/components/ui";
import {
  AppPageHeader,
  HEADER_ICON_BUTTON_CLASS,
} from "@/components/layout/AppPageHeader";
import { cn } from "@/lib/utils";
import type { ThreadGitActionDialogTarget } from "@/components/thread/dialogs/ThreadGitActionDialog";
import type { ThreadEnvironmentPromotionDialogTarget } from "@/components/thread/dialogs/ThreadEnvironmentPromotionDialog";
import type { ThreadEnvironmentPromotionHeaderAction } from "@/views/thread-detail/threadEnvironmentPromotionActions";

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
  isPromoted: boolean;
  isThreadGitActionPending: boolean;
  onOpenThreadGitAction: (target: ThreadGitActionDialogTarget) => void;
  onOpenThreadPromotionAction: (
    target: ThreadEnvironmentPromotionDialogTarget,
  ) => void;
  onToggleSecondaryPanel: () => void;
  threadHeaderGitActions: ThreadHeaderGitAction[];
  threadHeaderPromotionAction: ThreadEnvironmentPromotionHeaderAction | null;
  threadTitle: string;
  workspaceOpenButton?: ReactNode;
}

interface PromotionActionButtonProps {
  action: ThreadEnvironmentPromotionHeaderAction;
  onOpen: (target: ThreadEnvironmentPromotionDialogTarget) => void;
}

function PromotionActionButton({ action, onOpen }: PromotionActionButtonProps) {
  if (action.kind === "hard-disabled") {
    return (
      <TooltipProvider delayDuration={150}>
        <Tooltip>
          <TooltipTrigger asChild>
            <span tabIndex={0} className="inline-flex">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled
                aria-label={action.label}
                className={cn(
                  THREAD_HEADER_ACTION_BUTTON_CLASS,
                  "pointer-events-none",
                )}
              >
                {action.label}
              </Button>
            </span>
          </TooltipTrigger>
          <TooltipContent>{action.tooltip}</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className={THREAD_HEADER_ACTION_BUTTON_CLASS}
      onClick={() => onOpen(action.target)}
    >
      {action.label}
    </Button>
  );
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
        <PromotionActionButton
          action={threadHeaderPromotionAction}
          onOpen={onOpenThreadPromotionAction}
        />
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
        <SecondaryPanelIcon />
      </Button>
    </>
  );

  return <AppPageHeader center={center} actions={actions} />;
}
